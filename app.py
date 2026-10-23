import os
import re
import logging
import uuid
import smtplib
import ssl
import base64
from email_tracking import ConfirmationStore, confirmation_fingerprint, sending_is_recent
from package_accounting import PackageAccountingError, package_operation
from flask import Flask, render_template, request, jsonify, redirect, send_file, session, render_template_string, url_for, g, has_request_context
from supabase import create_client
from dotenv import load_dotenv
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from calendar import monthrange
from functools import wraps
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename

from io import BytesIO
from email.message import EmailMessage
from email.utils import formataddr


import requests
try:
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration
except ImportError:
    sentry_sdk = None
    FlaskIntegration = None

from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.pagesizes import A4

# ===============================
# CONFIG BASE
# ===============================

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


class RequestContextFilter(logging.Filter):
    def filter(self, record):
        if has_request_context():
            record.request_id = getattr(g, "request_id", "-")
            record.request_method = request.method
            record.request_path = request.path
        else:
            record.request_id = "-"
            record.request_method = "-"
            record.request_path = "-"
        return True


def configure_logging():
    log_level_name = (os.getenv("LOG_LEVEL") or "INFO").upper()
    log_level = getattr(logging, log_level_name, logging.INFO)
    root_logger = logging.getLogger()

    if not root_logger.handlers:
        logging.basicConfig(
            level=log_level,
            format="%(asctime)s %(levelname)s [%(request_id)s] %(request_method)s %(request_path)s %(name)s: %(message)s"
        )
    else:
        root_logger.setLevel(log_level)
        for handler in root_logger.handlers:
            handler.setLevel(log_level)

    for handler in root_logger.handlers:
        has_filter = any(isinstance(flt, RequestContextFilter) for flt in handler.filters)
        if not has_filter:
            handler.addFilter(RequestContextFilter())

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static")
)

configure_logging()
app.config["SHOW_PAYMENTS"] = (os.getenv("SHOW_PAYMENTS") or "false").strip().lower() in {"true", "1", "yes"}

app.secret_key = os.getenv("SECRET_KEY", "super-secret-key-change-me")

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")


supabase = create_client(SUPABASE_URL, SUPABASE_KEY)


def init_sentry():
    sentry_dsn = (os.getenv("SENTRY_DSN") or "").strip()
    if not sentry_dsn:
        return

    if sentry_sdk is None:
        app.logger.warning("SENTRY_DSN impostata ma sentry-sdk non installato.")
        return

    traces_sample_rate_raw = os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0")
    try:
        traces_sample_rate = float(traces_sample_rate_raw)
    except ValueError:
        traces_sample_rate = 0.0

    environment = os.getenv("SENTRY_ENVIRONMENT") or os.getenv("RENDER_ENV") or "production"

    sentry_sdk.init(
        dsn=sentry_dsn,
        integrations=[FlaskIntegration()],
        traces_sample_rate=traces_sample_rate,
        environment=environment,
        release=os.getenv("RENDER_GIT_COMMIT")
    )
    app.logger.info(
        "Sentry attivo (env=%s, traces_sample_rate=%s)",
        environment,
        traces_sample_rate
    )


init_sentry()


@app.context_processor
def inject_static_file_helper():
    def static_file(filename):
        file_path = os.path.join(app.static_folder, filename)
        try:
            version = int(os.path.getmtime(file_path))
        except OSError:
            version = 0
        return url_for("static", filename=filename, v=version)

    return {"static_file": static_file, "show_payments": app.config["SHOW_PAYMENTS"]}

# ===============================
# SIMPLE DASHBOARD CACHE
# ===============================
_dashboard_cache = {
    "timestamp": None,
    "pacchetti": 0,
    "clienti": 0
}

# ===============================
# SIMPLE PACCHETTI DASHBOARD CACHE
# ===============================
_pacchetti_dashboard_cache = {
    "timestamp": None,
    "data": []
}

# ===============================
# SIMPLE CALENDAR CACHE
# ===============================
_calendar_cache = {
    "key": None,
    "timestamp": None,
    "data": []
}


def invalidate_calendar_cache():
    global _calendar_cache
    _calendar_cache = {
        "key": None,
        "timestamp": None,
        "data": []
    }


def invalidate_dashboard_caches():
    global _dashboard_cache, _pacchetti_dashboard_cache
    _dashboard_cache = {
        "timestamp": None,
        "pacchetti": 0,
        "clienti": 0
    }
    _pacchetti_dashboard_cache = {
        "timestamp": None,
        "data": []
    }


def assegna_pacchetto_a_cliente(cliente_id, tipo_pacchetto_id):
    result = package_operation(supabase, "assign", {
        "cliente_id": cliente_id, "tipo_pacchetto_id": tipo_pacchetto_id,
    })
    invalidate_calendar_cache()
    invalidate_dashboard_caches()
    return result.get("pacchetto")


@app.errorhandler(PackageAccountingError)
def package_accounting_error(error):
    return jsonify({"error": str(error)}), error.status


def normalize_datetime_local(value):
    if not value or not isinstance(value, str):
        return value

    normalized = value.strip().replace("Z", "")
    normalized = re.sub(r"([+-]\d{2}:\d{2})$", "", normalized)

    try:
        dt = datetime.fromisoformat(normalized)
        return dt.replace(microsecond=0).isoformat()
    except ValueError:
        return normalized


def escape_ics_value(value):
    return str(value or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def piega_riga_ics(riga):
    """Rispetta il limite RFC 5545 di 75 ottetti per ogni riga ICS."""
    righe = []
    corrente = ""
    lunghezza_corrente = 0

    for carattere in riga:
        lunghezza_carattere = len(carattere.encode("utf-8"))
        if corrente and lunghezza_corrente + lunghezza_carattere > 75:
            righe.append(corrente)
            corrente = f" {carattere}"
            lunghezza_corrente = 1 + lunghezza_carattere
        else:
            corrente += carattere
            lunghezza_corrente += lunghezza_carattere

    righe.append(corrente)
    return "\r\n".join(righe)


def nome_file_calendario(nome_cliente, numero_seduta=None):
    """Nome leggibile dell'allegato, ripulito dai caratteri non sicuri per i file."""
    nome_base = secure_filename("-".join((nome_cliente or "").split()))[:120].strip(".-_") or "Appuntamento"
    nome_base = re.sub(r"[-_]+", "-", nome_base)
    suffisso = f"-seduta-{secure_filename(str(numero_seduta))}" if numero_seduta else ""
    return f"{nome_base}{suffisso}.ics"


def genera_file_calendario(appuntamento, servizio_nome, info_seduta=None, nome_cliente=None):
    """Crea un allegato ICS personalizzato, senza note cliniche."""
    timezone_roma = ZoneInfo("Europe/Rome")

    def parse_data_ora(value):
        data_ora = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if data_ora.tzinfo is None:
            return data_ora.replace(tzinfo=timezone_roma)
        return data_ora.astimezone(timezone_roma)

    inizio = parse_data_ora(appuntamento["start_datetime"])
    fine = parse_data_ora(appuntamento["end_datetime"])
    descrizione = f"Appuntamento presso Massoterapia & PT di Christian Di Tommaso."
    if info_seduta:
        descrizione += f"\n{info_seduta}"

    nome_cliente = " ".join((nome_cliente or "").split())
    titolo = f"{nome_cliente} – {servizio_nome}" if nome_cliente else f"Massoterapia & PT – {servizio_nome}"
    if info_seduta:
        titolo += f" – {info_seduta.replace('Seduta:', 'Seduta', 1)}"

    uid_dominio = (os.getenv("CALENDAR_UID_DOMAIN") or "gestionale.local").strip()
    righe = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Massoterapia & PT//Gestionale//IT",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:appuntamento-{appuntamento['id']}@{uid_dominio}",
        f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        f"DTSTART;TZID=Europe/Rome:{inizio.strftime('%Y%m%dT%H%M%S')}",
        f"DTEND;TZID=Europe/Rome:{fine.strftime('%Y%m%dT%H%M%S')}",
        f"SUMMARY:{escape_ics_value(titolo)}",
        "LOCATION:Via Michele Lessona 9\\, Milano",
        f"DESCRIPTION:{escape_ics_value(descrizione)}",
        "END:VEVENT",
        "END:VCALENDAR",
        ""
    ]
    return "\r\n".join(piega_riga_ics(riga) for riga in righe).encode("utf-8")


def recupera_dati_pacchetto(pacchetto_id):
    if not pacchetto_id:
        return None

    try:
        response = supabase.table("pacchetti_cliente") \
            .select("cliente_id,tipi_pacchetto(numero_sedute)") \
            .eq("id", pacchetto_id) \
            .single() \
            .execute()
        pacchetto = response.data or {}
        totale_sedute = (pacchetto.get("tipi_pacchetto") or {}).get("numero_sedute")
        if pacchetto.get("cliente_id") and totale_sedute:
            return {"cliente_id": pacchetto["cliente_id"], "totale_sedute": totale_sedute}
    except Exception:
        app.logger.exception("Impossibile recuperare i dati del pacchetto per l'email di conferma")
    return None


def prenota_conferma(appuntamento, cliente, allow_uncertain=False):
    try:
        return ConfirmationStore(supabase).claim(
            appuntamento["id"], cliente["id"], confirmation_fingerprint(appuntamento, cliente.get("email")), allow_uncertain
        )
    except Exception:
        app.logger.warning("Stato conferma non disponibile code=tracking_unavailable")
        return {"acquired": False, "reason": "tracking_unavailable"}


def registra_esito_conferma(appuntamento, cliente, claim, risultato):
    try:
        code = risultato.get("error_code")
        status = "sent" if risultato["success"] else "unknown" if code in {"timeout", "delivery_unknown"} else "failed"
        if code == "missing_email":
            status = "missing_email"
        ConfirmationStore(supabase).finish(
            appuntamento["id"], cliente["id"], claim["attempt_id"], status, code, risultato.get("provider")
        )
        return True
    except Exception:
        app.logger.warning("Salvataggio stato conferma non riuscito code=tracking_unavailable")
        return False


def invia_conferme_appuntamento(appuntamenti, clienti_ids, servizio_id, allow_uncertain=False):
    """Invia le conferme dopo il salvataggio, senza rendere fallibile l'appuntamento."""
    esito = {
        "requested": True,
        "attempted_count": 0,
        "sent_count": 0,
        "failed_count": 0,
        "skipped_no_email_count": 0,
        "errors": [],
        "skipped_already_sent_count": 0,
    }
    if not appuntamenti or not clienti_ids:
        return esito

    try:
        servizio_response = supabase.table("servizi") \
            .select("nome") \
            .eq("id", servizio_id) \
            .single() \
            .execute()
        servizio_nome = (servizio_response.data or {}).get("nome")
    except Exception:
        app.logger.exception("Impossibile recuperare il servizio per l'email di conferma")
        esito["failed_count"] = len(appuntamenti) * len(clienti_ids)
        return esito

    if not servizio_nome:
        app.logger.warning("Email di conferma non inviata: servizio non disponibile")
        esito["failed_count"] = len(appuntamenti) * len(clienti_ids)
        return esito

    clienti_con_email = []
    for cliente_id in clienti_ids:
        try:
            cliente_response = supabase.table("clienti") \
                .select("id,nome,cognome,email") \
                .eq("id", cliente_id) \
                .single() \
                .execute()
            cliente = cliente_response.data
            if cliente:
                clienti_con_email.append(cliente)
            else:
                esito["skipped_no_email_count"] += 1
        except Exception:
            app.logger.exception("Impossibile recuperare il cliente per l'email di conferma")
            esito["failed_count"] += len(appuntamenti)

    for appuntamento in appuntamenti:
        try:
            inizio = datetime.fromisoformat(appuntamento["start_datetime"].replace("Z", "+00:00"))
            fine = datetime.fromisoformat(appuntamento["end_datetime"].replace("Z", "+00:00"))
            dati_pacchetto = recupera_dati_pacchetto(appuntamento.get("pacchetto_cliente_id"))
            appuntamento_di_coppia = "coppia" in servizio_nome.casefold()

            for cliente in clienti_con_email:
                if not (cliente.get("email") or "").strip():
                    esito["skipped_no_email_count"] += 1
                    claim = prenota_conferma(appuntamento, cliente, allow_uncertain)
                    if claim["acquired"]:
                        registra_esito_conferma(appuntamento, cliente, claim, {"success": False, "error_code": "missing_email"})
                    continue
                info_seduta = None
                if (
                    dati_pacchetto
                    and (
                        appuntamento_di_coppia
                        or str(dati_pacchetto["cliente_id"]) == str(cliente.get("id"))
                    )
                    and appuntamento.get("numero_seduta")
                ):
                    info_seduta = f"Seduta: {appuntamento['numero_seduta']} di {dati_pacchetto['totale_sedute']}"

                righe_seduta = f"{info_seduta}\n" if info_seduta else ""
                corpo = f"""Ciao {cliente.get('nome') or ''},

ti confermo il tuo prossimo appuntamento presso Massoterapia & PT di Christian Di Tommaso.

I dettagli del tuo appuntamento

Data: {inizio.strftime('%d/%m/%Y')}
Orario: {inizio.strftime('%H:%M')} – {fine.strftime('%H:%M')}
Servizio: {servizio_nome}
{righe_seduta}Luogo: Via Michele Lessona 9, Milano

Per comodità, trovi in allegato il file per aggiungere l'appuntamento al tuo calendario personale, Google Calendar o Apple Calendar.

Per qualsiasi necessità o variazione, puoi contattarmi direttamente.

A presto!

Christian Di Tommaso
Massoterapia & PT
Via Michele Lessona 9, Milano
ditommaso.massoterapia@gmail.com
"""
                nome_cliente = " ".join(
                    str(cliente.get(campo) or "").strip() for campo in ("nome", "cognome")
                ).strip()
                calendario = genera_file_calendario(appuntamento, servizio_nome, info_seduta, nome_cliente)
                nome_allegato = nome_file_calendario(
                    nome_cliente, appuntamento.get("numero_seduta") if info_seduta else None
                )
                allegati = [(nome_allegato, calendario, "text", "calendar")]
                claim = prenota_conferma(appuntamento, cliente, allow_uncertain)
                if not claim["acquired"]:
                    code = claim["reason"]
                    if code == "already_sent":
                        esito["skipped_already_sent_count"] += 1
                    else:
                        esito["failed_count"] += 1
                        errore = {"code": code, "message": EMAIL_ERROR_MESSAGES[code]}
                        if errore not in esito["errors"]:
                            esito["errors"].append(errore)
                    continue
                esito["attempted_count"] += 1
                risultato_email = invia_email_dettagliata(
                    cliente["email"],
                    "Conferma appuntamento – Massoterapia & PT",
                    corpo,
                    allegati=allegati
                )
                if not registra_esito_conferma(appuntamento, cliente, claim, risultato_email):
                    errore = {"code": "tracking_unavailable", "message": EMAIL_ERROR_MESSAGES["tracking_unavailable"]}
                    if errore not in esito["errors"]:
                        esito["errors"].append(errore)
                if risultato_email["success"]:
                    esito["sent_count"] += 1
                else:
                    esito["failed_count"] += 1
                    errore = {
                        "code": risultato_email["error_code"],
                        "message": risultato_email["message"],
                    }
                    if errore not in esito["errors"]:
                        esito["errors"].append(errore)
                    app.logger.warning("Invio conferma non riuscito appuntamento_id=%s", appuntamento.get("id"))
        except Exception:
            # L'appuntamento e' gia' stato creato: un errore email non deve annullarlo.
            esito["failed_count"] += len(clienti_con_email)
            app.logger.exception("Errore invio email di conferma appuntamento_id=%s", appuntamento.get("id"))

    return esito


def invia_email(destinatario, oggetto, corpo, allegati=None):
    """Mantiene il risultato booleano usato dai chiamanti esistenti."""
    return invia_email_dettagliata(destinatario, oggetto, corpo, allegati)["success"]


EMAIL_ERROR_MESSAGES = {
    "tracking_unavailable": "Stato email non disponibile: verifica il collegamento al database prima di riprovare.",
    "already_sent": "La conferma è già stata inviata a questo cliente.",
    "send_in_progress": "Invio già in corso. Attendi prima di riprovare.",
    "delivery_unknown": "Esito incerto: l'email potrebbe essere già partita. Verifica prima di reinviarla.",
    "invalid_provider": "Servizio email non valido: imposta EMAIL_PROVIDER su gmail o resend.",
    "missing_configuration": "Configurazione email incompleta per il servizio selezionato.",
    "authentication_failed": "Autenticazione email non riuscita: controlla le credenziali del servizio.",
    "network_unreachable": "Connessione al servizio email non disponibile. Se usi Gmail su Render Free, le porte SMTP sono bloccate.",
    "connection_failed": "Impossibile collegarsi al servizio email: controlla la connessione del server.",
    "timeout": "Il servizio email non ha risposto in tempo: invio non confermato.",
    "tls_failed": "Connessione sicura al servizio email non riuscita.",
    "sender_not_verified": "Mittente email non autorizzato: verifica il dominio e l'indirizzo mittente su Resend.",
    "test_recipient_only": "Resend è in modalità di prova: per inviare ai clienti serve un dominio verificato.",
    "permission_denied": "Invio email non autorizzato: controlla i permessi del servizio email.",
    "recipient_rejected": "Il servizio email ha rifiutato l'indirizzo del destinatario.",
    "sender_rejected": "Il servizio email ha rifiutato l'indirizzo mittente.",
    "rate_limited": "Limite di invio email raggiunto. Riprova più tardi.",
    "provider_unavailable": "Servizio email temporaneamente non disponibile.",
    "send_failed": "Invio email non riuscito: controlla la configurazione del servizio.",
}


def esito_invio_email(provider, error_code=None):
    """Restituisce solo codici e messaggi controllati, senza risposte o segreti del provider."""
    if error_code:
        app.logger.warning("Invio email fallito provider=%s code=%s", provider, error_code)
    return {
        "success": error_code is None,
        "provider": provider,
        "error_code": error_code,
        "message": EMAIL_ERROR_MESSAGES.get(error_code) if error_code else None,
    }


def invia_email_dettagliata(destinatario, oggetto, corpo, allegati=None):
    """Usa il provider esplicito; senza EMAIL_PROVIDER conserva la selezione precedente.

    Non effettua fallback o reinvii automatici: dopo un timeout l'accettazione
    del messaggio potrebbe essere avvenuta, quindi un secondo invio può duplicarlo.
    """
    # EMAIL_USER / EMAIL_PASS sono mantenute per compatibilita' con la configurazione Render esistente.
    gmail_email = (os.getenv("GMAIL_EMAIL") or os.getenv("EMAIL_USER") or "").strip()
    gmail_app_password = "".join(
        (os.getenv("GMAIL_APP_PASSWORD") or os.getenv("EMAIL_PASS") or "").split()
    )
    provider = (os.getenv("EMAIL_PROVIDER") or "").strip().lower()
    if provider and provider not in {"gmail", "resend"}:
        return esito_invio_email("invalid", "invalid_provider")
    if not provider:
        provider = "gmail" if gmail_email and gmail_app_password else "resend"

    if provider == "gmail":
        if not gmail_email or not gmail_app_password:
            return esito_invio_email(provider, "missing_configuration")
        accepted = False
        sending = False

        def smtp_failure(code):
            if accepted:
                return esito_invio_email(provider)
            if sending and code in {"timeout", "connection_failed", "network_unreachable", "send_failed", "tls_failed"}:
                code = "delivery_unknown"
            return esito_invio_email(provider, code)
        try:
            messaggio = EmailMessage()
            messaggio["From"] = formataddr((os.getenv("GMAIL_FROM_NAME", "Gestionale"), gmail_email))
            messaggio["To"] = destinatario
            messaggio["Subject"] = oggetto
            messaggio.set_content(corpo)
            for nome_file, contenuto, maintype, subtype in allegati or []:
                messaggio.add_attachment(
                    contenuto,
                    maintype=maintype,
                    subtype=subtype,
                    filename=nome_file
                )

            context = ssl.create_default_context()
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=context, timeout=10) as smtp:
                smtp.login(gmail_email, gmail_app_password)
                sending = True
                smtp.send_message(messaggio)
                accepted = True
            return esito_invio_email(provider)
        except smtplib.SMTPAuthenticationError:
            return smtp_failure("authentication_failed")
        except smtplib.SMTPRecipientsRefused:
            return smtp_failure("recipient_rejected")
        except smtplib.SMTPSenderRefused:
            return smtp_failure("sender_rejected")
        except ssl.SSLError:
            return smtp_failure("tls_failed")
        except TimeoutError:
            return smtp_failure("timeout")
        except smtplib.SMTPException:
            return smtp_failure("send_failed")
        except OSError as error:
            code = "network_unreachable" if error.errno in {101, 113} else "connection_failed"
            return smtp_failure(code)
        except Exception:
            return smtp_failure("send_failed")

    resend_api_key = (os.getenv("RESEND_API_KEY") or "").strip()
    if not resend_api_key:
        return esito_invio_email(provider, "missing_configuration")

    try:
        payload = {
            "from": os.getenv("RESEND_FROM_EMAIL", "Gestionale <onboarding@resend.dev>"),
            "to": [destinatario],
            "subject": oggetto,
            "text": corpo
        }
        if allegati:
            payload["attachments"] = [
                {
                    "filename": nome_file,
                    "content": base64.b64encode(contenuto).decode("ascii")
                }
                for nome_file, contenuto, _maintype, _subtype in allegati
            ]

        response = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {resend_api_key}",
                "Content-Type": "application/json"
            },
            json=payload,
            timeout=10
        )
        if response.status_code in [200, 201]:
            return esito_invio_email(provider)

        # Il testo esterno serve solo alla classificazione: non viene esposto o registrato.
        try:
            errore = response.json()
        except ValueError:
            errore = {}
        if not isinstance(errore, dict):
            errore = {}
        nome_errore = str(errore.get("name", "")).lower()
        messaggio_errore = str(errore.get("message", "")).lower()
        code = "send_failed"
        if (response.status_code == 401
                or nome_errore in {"invalid_api_key", "missing_api_key", "restricted_api_key", "suspended_api_key"}
                or (response.status_code == 400 and "api key is invalid" in messaggio_errore)):
            code = "authentication_failed"
        elif response.status_code in {400, 403, 422} and "only send testing emails" in messaggio_errore:
            code = "test_recipient_only"
        elif response.status_code in {400, 403, 422} and "domain" in messaggio_errore and "verif" in messaggio_errore:
            code = "sender_not_verified"
        elif response.status_code == 403:
            code = "permission_denied"
        elif response.status_code == 429:
            code = "rate_limited"
        elif response.status_code >= 500:
            code = "provider_unavailable"
        return esito_invio_email(provider, code)
    except requests.exceptions.Timeout:
        return esito_invio_email(provider, "timeout")
    except requests.exceptions.SSLError:
        return esito_invio_email(provider, "tls_failed")
    except requests.exceptions.ConnectionError:
        # La connessione può cadere dopo l'accettazione da parte dell'API.
        return esito_invio_email(provider, "delivery_unknown")
    except Exception:
        return esito_invio_email(provider, "send_failed")


@app.before_request
def attach_request_id():
    incoming_request_id = (request.headers.get("X-Request-ID") or "").strip()
    g.request_id = incoming_request_id[:64] if incoming_request_id else uuid.uuid4().hex[:12]


@app.after_request
def add_request_id_header(response):
    request_id = getattr(g, "request_id", None)
    if request_id:
        response.headers["X-Request-ID"] = request_id
    return response


@app.errorhandler(Exception)
def handle_unexpected_exception(error):
    if isinstance(error, HTTPException):
        return error

    request_id = getattr(g, "request_id", "n/a")
    app.logger.exception("Errore non gestito (request_id=%s)", request_id)

    if request.path.startswith("/api/"):
        return jsonify({
            "error": "Errore interno del server",
            "request_id": request_id
        }), 500

    return render_template_string(
        """
        <h3>Errore interno del server</h3>
        <p>ID richiesta: {{ request_id }}</p>
        """,
        request_id=request_id
    ), 500


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({
        "status": "ok",
        "service": "gestionale",
        "timestamp": datetime.utcnow().replace(microsecond=0).isoformat() + "Z"
    })

# ===============================
# LOGIN REQUIRED DECORATOR
# ===============================

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect("/login")
        return f(*args, **kwargs)
    return decorated_function

# ===============================
# HOME
# ===============================

@app.route("/")
@login_required
def index():

    global _dashboard_cache
    from datetime import timedelta

    now = datetime.now()

    # Read current ledger: process-local caches can be stale in another Render worker.

    # Conteggio pacchetti attivi
    pacchetti_attivi = supabase.table("pacchetti_cliente") \
        .select("id", count="exact") \
        .eq("stato", "attivo") \
        .execute()

    totale_pacchetti_attivi = pacchetti_attivi.count if pacchetti_attivi.count else 0

    # Conteggio clienti totali
    clienti_totali = supabase.table("clienti") \
        .select("id", count="exact") \
        .execute()

    totale_clienti = clienti_totali.count if clienti_totali.count else 0

    # Salva in cache
    _dashboard_cache = {
        "timestamp": now,
        "pacchetti": totale_pacchetti_attivi,
        "clienti": totale_clienti
    }

    return render_template(
        "index.html",
        dashboard_pacchetti=totale_pacchetti_attivi,
        dashboard_clienti=totale_clienti
    )

# ===============================
# API CLIENTI
# ===============================

# ===============================
# LOGIN
# ===============================

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email")
        password = request.form.get("password")

        if email == ADMIN_EMAIL and password == ADMIN_PASSWORD:
            session["logged_in"] = True
            return redirect("/")
        else:
            error = "Credenziali non valide"
    else:
        error = None

    # Login page styled like gestionale (Apple minimal)
    return render_template_string("""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset=\"UTF-8\">
        <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">
        <title>Login - Gestionale</title>
        <link rel=\"stylesheet\" href=\"{{ static_file('style.css') }}\">
    </head>
    <body style=\"display:flex;justify-content:center;align-items:center;height:100vh;background:linear-gradient(135deg,#f3f4f6,#e5e7eb);\">
        <div class=\"detail-card\" style=\"width:380px;\">
            <h3 style=\"margin-bottom:25px;\">Accesso Gestionale</h3>
            <form method=\"POST\" style=\"display:flex;flex-direction:column;gap:16px;\">
                <input type=\"email\" name=\"email\" placeholder=\"Email\" required class=\"input-apple\">
                <input type=\"password\" name=\"password\" placeholder=\"Password\" required class=\"input-apple\">
                <button type=\"submit\" class=\"btn-apple-primary\" style=\"width:100%;\">Accedi</button>
            </form>
            {% if error %}
                <p style=\"color:#ef4444;margin-top:18px;font-size:14px;\">{{ error }}</p>
            {% endif %}
        </div>
    </body>
    </html>
    """, error=error)

@app.route("/logout")
@login_required
def logout():
    session.clear()
    return redirect("/login")

@app.route("/api/clienti", methods=["GET"])
@login_required
def get_clienti():
    response = supabase.table("clienti") \
        .select("id,nome,cognome,telefono,email") \
        .execute()
    return jsonify(response.data)


@app.route("/api/clienti", methods=["POST"])
@login_required
def crea_cliente():
    data = request.json or {}

    telefono = data.get("telefono")

    # Normalizzazione telefono (aggiunge 39 se numero italiano senza prefisso)
    if telefono:
        telefono = telefono.replace(" ", "").replace("-", "").replace("+", "")
        if telefono.startswith("3") and len(telefono) == 10:
            telefono = "39" + telefono
        data["telefono"] = telefono

    response = supabase.table("clienti").insert(data).execute()
    return jsonify(response.data)

# PUT route per aggiornare dati anagrafici di un cliente
@app.route("/api/clienti/<cliente_id>", methods=["PUT"])
@login_required
def aggiorna_cliente(cliente_id):
    data = request.json

    telefono = data.get("telefono")

    # Normalizzazione telefono
    if telefono:
        telefono = telefono.replace(" ", "").replace("-", "").replace("+", "")
        if telefono.startswith("3") and len(telefono) == 10:
            telefono = "39" + telefono

    # Permettiamo solo campi modificabili
    campi_aggiornabili = {
        "nome": data.get("nome"),
        "cognome": data.get("cognome"),
        "telefono": telefono,
        "email": data.get("email")
    }

    # Rimuoviamo eventuali None
    campi_aggiornabili = {k: v for k, v in campi_aggiornabili.items() if v is not None}

    response = supabase.table("clienti") \
        .update(campi_aggiornabili) \
        .eq("id", cliente_id) \
        .execute()

    return jsonify(response.data)

# Aggiunta rapida dalla creazione appuntamento: mai sovrascrivere un'email esistente.
@app.route("/api/clienti/<cliente_id>/email", methods=["PUT"])
@login_required
def aggiungi_email_cliente(cliente_id):
    data = request.get_json(silent=True)
    email = data.get("email") if isinstance(data, dict) else None
    if not isinstance(email, str):
        return jsonify({"error": "Inserisci un indirizzo email valido"}), 400
    email = email.strip()
    if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        return jsonify({"error": "Inserisci un indirizzo email valido"}), 400

    rows = supabase.table("clienti").select("id,email").eq("id", cliente_id).limit(1).execute().data or []
    if not rows:
        return jsonify({"error": "Cliente non trovato"}), 404
    precedente = rows[0].get("email")
    if precedente and precedente.strip():
        if precedente.strip().casefold() == email.casefold():
            return jsonify({"id": rows[0]["id"], "email": precedente.strip()})
        return jsonify({"error": "Il cliente ha già un'email in anagrafica. Ricarica i clienti prima di riprovare."}), 409

    query = supabase.table("clienti").update({"email": email}).eq("id", cliente_id)
    # Compare-and-swap: un altro operatore potrebbe averla aggiunta nel frattempo.
    query = query.is_("email", "null") if precedente is None else query.eq("email", precedente)
    aggiornati = query.execute().data or []
    if not aggiornati:
        return jsonify({"error": "L'anagrafica è cambiata. Ricarica i clienti prima di riprovare."}), 409
    return jsonify({"id": aggiornati[0]["id"], "email": aggiornati[0]["email"]})

# DELETE route per eliminare cliente
@app.route("/api/clienti/<cliente_id>", methods=["DELETE"])
@login_required
def elimina_cliente(cliente_id):
    result = package_operation(supabase, "delete_client", {"id": cliente_id})
    if not result.get("deleted"):
        return jsonify({"error": "Cliente non trovato"}), 404
    invalidate_calendar_cache()
    invalidate_dashboard_caches()
    return jsonify({"success": True})

# GET route per recuperare singolo cliente (usato per WhatsApp reminder)
@app.route("/api/clienti/<cliente_id>", methods=["GET"])
@login_required
def get_cliente_singolo(cliente_id):
    response = supabase.table("clienti") \
        .select("id, nome, cognome, telefono, email") \
        .eq("id", cliente_id) \
        .single() \
        .execute()

    if not response.data:
        return jsonify({"error": "Cliente non trovato"}), 404

    return jsonify(response.data)

# ===============================
# API APPUNTAMENTI
# ===============================

@app.route("/api/appuntamenti", methods=["GET"])
@login_required
def get_appuntamenti():

    start = request.args.get("start")
    end = request.args.get("end")
    stato = (request.args.get("stato") or "").strip()
    servizio_id = (request.args.get("servizio_id") or "").strip()
    cliente_query = (request.args.get("cliente") or "").strip().lower()
    data_da = (request.args.get("data_da") or "").strip()
    data_a = (request.args.get("data_a") or "").strip()

    global _calendar_cache
    from datetime import timedelta

    cache_key = f"{start}_{end}_{stato}_{servizio_id}_{cliente_query}_{data_da}_{data_a}"
    now = datetime.now()

    # Always read current numbering, including when another worker changed a package.

    # 🔧 Normalizzazione formato ISO (rimuove timezone se presente)
    if start:
        start = normalize_datetime_local(start)
    if end:
        end = normalize_datetime_local(end)

    start_filtro = None
    end_filtro = None

    if data_da:
        try:
            start_filtro = f"{datetime.fromisoformat(data_da).date().isoformat()}T00:00:00"
        except ValueError:
            start_filtro = None

    if data_a:
        try:
            giorno_successivo = datetime.fromisoformat(data_a).date() + timedelta(days=1)
            end_filtro = f"{giorno_successivo.isoformat()}T00:00:00"
        except ValueError:
            end_filtro = None

    effective_start = start
    effective_end = end

    if start_filtro and (not effective_start or start_filtro > effective_start):
        effective_start = start_filtro
    if end_filtro and (not effective_end or end_filtro < effective_end):
        effective_end = end_filtro

    if effective_start and effective_end and effective_start >= effective_end:
        return jsonify([])

    query = supabase.table("appuntamenti") \
        .select("""
            *,
            servizi(nome,colore_calendario),
            appuntamenti_clienti(
                cliente_id,
                clienti(nome,cognome)
            )
        """)

    if stato:
        query = query.eq("stato", stato)

    if servizio_id:
        query = query.eq("servizio_id", servizio_id)

    # 🔹 Filtro per intervallo visibile (se presente)
    if effective_start and effective_end:
        query = query.gte("start_datetime", effective_start).lt("start_datetime", effective_end)
    elif effective_start:
        query = query.gte("start_datetime", effective_start)
    elif effective_end:
        query = query.lt("start_datetime", effective_end)

    try:
        response = query.execute()
    except Exception as e:
        app.logger.exception("Errore query Supabase /api/appuntamenti")
        return jsonify([])

    if not response or response.data is None:
        app.logger.warning("Response Supabase vuota su /api/appuntamenti: %s", response)
        return jsonify([])

    eventi = []

    for appo in response.data:

        clienti_nomi = []
        clienti_ids = []

        for relazione in appo.get("appuntamenti_clienti", []):
            cliente = relazione.get("clienti")
            cliente_id = relazione.get("cliente_id")

            if cliente:
                clienti_nomi.append(f"{cliente['nome']} {cliente['cognome']}")

            if cliente_id:
                clienti_ids.append(cliente_id)

        nomi_clienti = " + ".join(clienti_nomi)

        if cliente_query and cliente_query not in nomi_clienti.lower():
            continue

        is_occupato = appo.get("stato") == "occupato"
        servizio = appo.get("servizi") or {}
        nome_servizio = servizio.get("nome") or ""
        colore = "#dc2626" if is_occupato else servizio.get("colore_calendario")

        # Il titolo deve contenere solo il servizio (i clienti vengono mostrati nel popup).
        titolo = "Occupato" if is_occupato else nome_servizio

        # 🔹 Aggiungi numero seduta se presente
        if not is_occupato and appo.get("numero_seduta"):
            titolo += f" (S{appo['numero_seduta']})"

        eventi.append({
            "id": appo["id"],
            "title": titolo,
            "start": appo["start_datetime"],
            "end": appo["end_datetime"],
            "backgroundColor": colore,
            "extendedProps": {
                "clienti": nomi_clienti,
                "clienti_ids": clienti_ids,
                "servizio": nome_servizio,
                "stato": appo.get("stato"),
                "occupato": is_occupato,
                "numero_seduta": appo.get("numero_seduta"),
                "note": appo.get("note") or "",
                "reminder_whatsapp": appo.get("reminder_whatsapp", False)
            }
        })

    _calendar_cache = {
        "key": cache_key,
        "timestamp": now,
        "data": eventi
    }

    return jsonify(eventi)

@app.route("/api/appuntamenti", methods=["POST"])
@login_required
def crea_appuntamento():
    from datetime import timedelta

    data = request.json or {}
    servizio_id = data.get("servizio_id")
    start_datetime = normalize_datetime_local(data.get("start_datetime"))
    end_datetime = normalize_datetime_local(data.get("end_datetime"))
    note_raw = data.get("note")
    note = note_raw.strip() if isinstance(note_raw, str) else ""
    occupato_raw = data.get("occupato", False)
    occupato = occupato_raw is True or (
        isinstance(occupato_raw, str) and occupato_raw.strip().lower() in {"true", "1", "si", "sì"}
    )
    invia_conferma_raw = data.get("invia_conferma_email", False)
    invia_conferma_email = invia_conferma_raw is True or (
        isinstance(invia_conferma_raw, str) and invia_conferma_raw.strip().lower() in {"true", "1", "si", "sì"}
    )

    clienti_ids = data.get("clienti_ids") or []
    cliente_id_singolo = data.get("cliente_id")

    # 🔹 Compatibilità con vecchio sistema
    if not clienti_ids and cliente_id_singolo:
        clienti_ids = [cliente_id_singolo]

    if not isinstance(clienti_ids, list):
        clienti_ids = [clienti_ids]

    clienti_ids = [cid for cid in clienti_ids if cid not in (None, "")]
    if occupato:
        clienti_ids = []

    # 🔒 Controllo sicurezza
    if not clienti_ids and not occupato:
        return jsonify({"error": "Nessun cliente selezionato"}), 400

    if not servizio_id:
        return jsonify({"error": "Servizio obbligatorio"}), 400

    if len(note) > 2000:
        return jsonify({"error": "Le note possono contenere al massimo 2000 caratteri"}), 400

    slots_personalizzati_raw = data.get("slots_personalizzati") or []
    slot_plan = []

    if slots_personalizzati_raw:
        if not isinstance(slots_personalizzati_raw, list):
            return jsonify({"error": "slots_personalizzati deve essere una lista"}), 400

        if len(slots_personalizzati_raw) > 80:
            return jsonify({"error": "Puoi creare al massimo 80 appuntamenti per volta"}), 400

        for slot in slots_personalizzati_raw:
            if not isinstance(slot, dict):
                return jsonify({"error": "Formato slot personalizzato non valido"}), 400

            slot_start_raw = normalize_datetime_local(slot.get("start_datetime"))
            slot_end_raw = normalize_datetime_local(slot.get("end_datetime"))

            if not slot_start_raw or not slot_end_raw:
                return jsonify({"error": "Ogni slot personalizzato richiede data inizio e fine"}), 400

            try:
                slot_start_dt = datetime.fromisoformat(slot_start_raw)
                slot_end_dt = datetime.fromisoformat(slot_end_raw)
            except ValueError:
                return jsonify({"error": "Formato data non valido negli slot personalizzati"}), 400

            if slot_end_dt <= slot_start_dt:
                return jsonify({"error": "In uno slot personalizzato l'orario di fine non è valido"}), 400

            slot_plan.append((slot_start_dt, slot_end_dt))

        # Ordina e rimuove eventuali duplicati identici
        slot_plan.sort(key=lambda pair: pair[0])
        unique_slot_plan = []
        seen_slots = set()
        for slot_start_dt, slot_end_dt in slot_plan:
            key = (slot_start_dt.isoformat(), slot_end_dt.isoformat())
            if key in seen_slots:
                continue
            seen_slots.add(key)
            unique_slot_plan.append((slot_start_dt, slot_end_dt))

        slot_plan = unique_slot_plan
    else:
        if not start_datetime or not end_datetime:
            return jsonify({"error": "Data e orario obbligatori"}), 400

        try:
            start_dt = datetime.fromisoformat(start_datetime)
            end_dt = datetime.fromisoformat(end_datetime)
        except ValueError:
            return jsonify({"error": "Formato data non valido"}), 400

        if end_dt <= start_dt:
            return jsonify({"error": "L'orario di fine deve essere successivo all'inizio"}), 400

        occorrenze_raw = data.get("occorrenze", 1)
        ripeti_settimanale = bool(data.get("ripeti_settimanale"))

        try:
            occorrenze = int(occorrenze_raw)
        except (TypeError, ValueError):
            return jsonify({"error": "Numero occorrenze non valido"}), 400

        if occorrenze < 1 or occorrenze > 52:
            return jsonify({"error": "Il numero di occorrenze deve essere tra 1 e 52"}), 400

        if occorrenze > 1:
            ripeti_settimanale = True
        if not ripeti_settimanale:
            occorrenze = 1

        for index in range(occorrenze):
            delta_giorni = timedelta(days=7 * index)
            occ_start_dt = (start_dt + delta_giorni).replace(microsecond=0)
            occ_end_dt = (end_dt + delta_giorni).replace(microsecond=0)
            slot_plan.append((occ_start_dt, occ_end_dt))

    result = package_operation(supabase, "create", {
        "clienti_ids": clienti_ids, "servizio_id": servizio_id,
        "pacchetto_cliente_id": None if occupato else data.get("pacchetto_cliente_id"),
        "occupato": occupato, "note": note or None,
        "invia_conferma_email": invia_conferma_email and not occupato,
        "slots": [{"start_datetime": start.isoformat(), "end_datetime": end.isoformat()} for start, end in slot_plan],
    })
    appuntamenti_creati = result.get("appuntamenti") or []
    if not appuntamenti_creati:
        return jsonify({"error": "Creazione non confermata: verifica il calendario prima di riprovare"}), 503
    appuntamenti_creati_ids = [row["id"] for row in appuntamenti_creati]
    primo_numero_seduta = appuntamenti_creati[0].get("numero_seduta")
    invalidate_calendar_cache()
    invalidate_dashboard_caches()
    email_confirmation = {
        "requested": False,
        "attempted_count": 0,
        "sent_count": 0,
        "failed_count": 0,
        "skipped_no_email_count": 0,
    }
    if invia_conferma_email and not occupato:
        email_confirmation = invia_conferme_appuntamento(
            appuntamenti_creati,
            clienti_ids,
            servizio_id
        ) or email_confirmation
    return jsonify({
        "success": True,
        "numero_seduta": primo_numero_seduta,
        "created_count": len(appuntamenti_creati_ids),
        "created_ids": appuntamenti_creati_ids,
        "package_uncovered_count": result.get("uncovered_count", 0),
        "email_confirmation": email_confirmation
    })

def appuntamento_e_destinatari(appuntamento_id):
    rows = supabase.table("appuntamenti").select("*").eq("id", appuntamento_id).limit(1).execute().data or []
    if not rows:
        return None, []
    appuntamento = rows[0]
    links = supabase.table("appuntamenti_clienti").select("cliente_id").eq("appuntamento_id", appuntamento_id).execute().data or []
    ids = list(dict.fromkeys(str(link["cliente_id"]) for link in links if link.get("cliente_id")))
    if not ids and appuntamento.get("cliente_id"):
        ids = [str(appuntamento["cliente_id"])]
    return appuntamento, ids


@app.route("/api/appuntamenti/<id>/conferme", methods=["GET", "POST"])
@login_required
def conferme_appuntamento(id):
    appuntamento, ids = appuntamento_e_destinatari(id)
    if not appuntamento:
        return jsonify({"error": "Appuntamento non trovato"}), 404
    if not isinstance(appuntamento.get("email_conferme"), dict):
        return jsonify({"error": EMAIL_ERROR_MESSAGES["tracking_unavailable"]}), 503
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        cliente_id = str(data.get("cliente_id") or "")
        if cliente_id not in ids:
            return jsonify({"error": "Cliente non associato a questo appuntamento"}), 400
        if appuntamento.get("stato") in {"annullato", "occupato"}:
            return jsonify({"error": "Non puoi confermare un appuntamento annullato o uno slot occupato"}), 409
        risultato = invia_conferme_appuntamento(
            [appuntamento], [cliente_id], appuntamento.get("servizio_id"), data.get("conferma_esito_incerto") is True
        )
        return jsonify({"success": True, "email_confirmation": risultato})

    destinatari = []
    for cliente_id in ids:
        rows = supabase.table("clienti").select("id,nome,cognome,email").eq("id", cliente_id).limit(1).execute().data or []
        if not rows:
            continue
        cliente = rows[0]
        stato = appuntamento["email_conferme"].get(cliente_id) or {}
        status = stato.get("status", "untracked")
        if status == "sending" and not sending_is_recent(stato):
            status = "unknown"
        if status == "sent" and stato.get("fingerprint") != confirmation_fingerprint(appuntamento, cliente.get("email")):
            status = "outdated"
        destinatari.append({
            "cliente_id": cliente_id,
            "nome": " ".join(str(cliente.get(key) or "") for key in ("nome", "cognome")).strip(),
            "has_email": bool((cliente.get("email") or "").strip()),
            "status": status,
            "updated_at": stato.get("updated_at"),
            "message": EMAIL_ERROR_MESSAGES.get(stato.get("error_code")),
            "can_send": bool((cliente.get("email") or "").strip()) and status not in {"sent", "sending"}
                and appuntamento.get("stato") not in {"annullato", "occupato"},
        })
    return jsonify({"destinatari": destinatari})


@app.route("/api/appuntamenti/conflitti", methods=["POST"])
@login_required
def conflitti_appuntamenti():
    data = request.get_json(silent=True) or {}
    slots = data.get("slots")
    if not isinstance(slots, list) or not 1 <= len(slots) <= 80:
        return jsonify({"error": "Specifica da 1 a 80 intervalli da verificare"}), 400
    intervalli = []
    try:
        for slot in slots:
            start = datetime.fromisoformat(normalize_datetime_local(slot.get("start_datetime")))
            end = datetime.fromisoformat(normalize_datetime_local(slot.get("end_datetime")))
            if end <= start:
                raise ValueError()
            intervalli.append((start, end))
    except (ValueError, TypeError, AttributeError):
        return jsonify({"error": "Intervallo non valido"}), 400
    first = min(start for start, _ in intervalli).isoformat()
    last = max(end for _, end in intervalli).isoformat()
    esistenti = []
    offset = 0
    while True:
        page = supabase.table("appuntamenti").select("id,start_datetime,end_datetime,stato") \
            .lt("start_datetime", last).gt("end_datetime", first).order("id").range(offset, offset + 999).execute().data or []
        esistenti.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    conflicts = set()
    for appo in esistenti:
        if str(appo.get("id")) == str(data.get("ignore_id")) or appo.get("stato") == "annullato":
            continue
        start = datetime.fromisoformat(normalize_datetime_local(appo["start_datetime"]))
        end = datetime.fromisoformat(normalize_datetime_local(appo["end_datetime"]))
        if any(start < to and end > frm for frm, to in intervalli):
            conflicts.add(str(appo["id"]))
    interni = sum(start1 < end2 and end1 > start2
                  for i, (start1, end1) in enumerate(intervalli) for start2, end2 in intervalli[i + 1:]
                  if (start1, end1) != (start2, end2))
    return jsonify({"count": len(conflicts), "internal_count": interni})


@app.route("/api/appuntamenti/<id>", methods=["PUT"])
@login_required
def aggiorna_appuntamento(id):
    data = request.json
    payload = dict(data or {})
    if "start_datetime" in payload:
        payload["start_datetime"] = normalize_datetime_local(payload.get("start_datetime"))
    if "end_datetime" in payload:
        payload["end_datetime"] = normalize_datetime_local(payload.get("end_datetime"))
    if "note" in payload:
        note_raw = payload.get("note")
        if not isinstance(note_raw, str):
            return jsonify({"error": "Le note non sono valide"}), 400
        note = note_raw.strip()
        if len(note) > 2000:
            return jsonify({"error": "Le note possono contenere al massimo 2000 caratteri"}), 400
        payload["note"] = note or None

    response = package_operation(supabase, "update", {"id": id, "changes": payload})
    invalidate_calendar_cache()
    invalidate_dashboard_caches()
    return jsonify(response.get("appuntamenti") or [])


@app.route("/api/appuntamenti/<id>", methods=["DELETE"])
@login_required
def elimina_appuntamento(id):
    package_operation(supabase, "delete", {"id": id})
    invalidate_calendar_cache()
    invalidate_dashboard_caches()
    return jsonify({"success": True})


# ===============================
# SET REMINDER WHATSAPP
# ===============================

@app.route("/api/appuntamenti/<app_id>/reminder_whatsapp", methods=["POST"])
@login_required
def set_reminder_whatsapp(app_id):

    response = supabase.table("appuntamenti") \
        .update({"reminder_whatsapp": True}) \
        .eq("id", app_id) \
        .execute()

    if not response.data:
        return jsonify({"error": "Appuntamento non trovato"}), 404

    invalidate_calendar_cache()
    return jsonify({"success": True})


# ===============================
# API per pacchetti attivi di un cliente
# ===============================

@app.route("/api/pacchetti_attivi/<cliente_id>", methods=["GET"])
@login_required
def get_pacchetti_attivi(cliente_id):

    pacchetti = supabase.table("pacchetti_cliente") \
        .select("*, tipi_pacchetto(nome, numero_sedute, servizio_id)") \
        .eq("cliente_id", cliente_id) \
        .eq("stato", "attivo") \
        .execute().data

    risultati = []

    for pac in pacchetti:
        numero_totale = pac["tipi_pacchetto"]["numero_sedute"]
        effettuate = pac["sedute_effettuate"]
        rimanenti = max(0, numero_totale - effettuate)

        risultati.append({
            "id": pac["id"],
            "nome": pac["tipi_pacchetto"]["nome"],
            "servizio_id": pac["tipi_pacchetto"]["servizio_id"],
            "sedute_rimanenti": rimanenti
        })

    return jsonify(risultati)


@app.route("/api/tipi_pacchetto", methods=["GET"])
@login_required
def get_tipi_pacchetto():
    response = supabase.table("tipi_pacchetto") \
        .select("id,nome,numero_sedute,servizio_id,servizi(nome)") \
        .order("nome") \
        .execute()
    return jsonify(response.data or [])


@app.route("/api/clienti/<cliente_id>/pacchetti", methods=["POST"])
@login_required
def assegna_pacchetto_cliente_api(cliente_id):
    data = request.json or {}
    tipo_pacchetto_id = str(data.get("tipo_pacchetto_id") or "").strip()

    if not tipo_pacchetto_id:
        return jsonify({"error": "tipo_pacchetto_id obbligatorio"}), 400

    pacchetto = assegna_pacchetto_a_cliente(cliente_id, tipo_pacchetto_id)
    invalidate_dashboard_caches()

    return jsonify({
        "success": True,
        "pacchetto": pacchetto
    })

# ===============================
# API DASHBOARD PACCHETTI ATTIVI
# ===============================

@app.route("/api/pacchetti_dashboard", methods=["GET"])
@login_required
def pacchetti_dashboard():

    global _pacchetti_dashboard_cache
    from datetime import timedelta

    now = datetime.now()

    # Never return a stale count from another worker's previous request.

    pacchetti = supabase.table("pacchetti_cliente") \
        .select("id,sedute_effettuate,clienti(nome,cognome),tipi_pacchetto(nome,numero_sedute)") \
        .eq("stato", "attivo") \
        .execute().data

    risultati = []

    for pac in pacchetti:
        numero_totale = pac["tipi_pacchetto"]["numero_sedute"]
        effettuate = pac["sedute_effettuate"]
        rimanenti = max(0, numero_totale - effettuate)

        cliente = pac.get("clienti")
        nome_cliente = ""
        if cliente:
            nome_cliente = f"{cliente['nome']} {cliente['cognome']}"

        risultati.append({
            "id": pac["id"],
            "cliente": nome_cliente,
            "nome_pacchetto": pac["tipi_pacchetto"]["nome"],
            "sedute_rimanenti": rimanenti
        })

    _pacchetti_dashboard_cache = {
        "timestamp": now,
        "data": risultati
    }

    return jsonify(risultati)

# ===============================
# API DASHBOARD APPUNTAMENTI OGGI
# ===============================

@app.route("/api/appuntamenti_oggi", methods=["GET"])
@login_required
def appuntamenti_oggi():

    from datetime import time

    now_dt = datetime.now()
    start_day = datetime.combine(now_dt.date(), time.min).isoformat()
    end_day = datetime.combine(now_dt.date(), time.max).isoformat()

    response = supabase.table("appuntamenti") \
        .select("id", count="exact") \
        .gte("start_datetime", start_day) \
        .lte("start_datetime", end_day) \
        .execute()

    totale = response.count if response.count else 0

    return jsonify({
        "totale": totale,
        "data": now_dt.date().isoformat()
    })


# ===============================
# API SERVIZI
# ===============================

@app.route("/api/servizi", methods=["GET"])
@login_required
def get_servizi():
    response = supabase.table("servizi") \
        .select("id,nome,colore_calendario") \
        .execute()
    return jsonify(response.data)


@app.route("/api/pagamenti/mese", methods=["GET"])
@login_required
def get_pagamenti_mese():
    mese = (request.args.get("mese") or "").strip()

    if not mese:
        return jsonify({"error": "Parametro mese obbligatorio (YYYY-MM)"}), 400

    try:
        mese_dt = datetime.strptime(mese, "%Y-%m")
    except ValueError:
        return jsonify({"error": "Formato mese non valido. Usa YYYY-MM"}), 400

    ultimo_giorno = monthrange(mese_dt.year, mese_dt.month)[1]
    start = f"{mese_dt.year:04d}-{mese_dt.month:02d}-01"
    end = f"{mese_dt.year:04d}-{mese_dt.month:02d}-{ultimo_giorno:02d}"

    response = supabase.table("pagamenti") \
        .select("id,cliente,importo,data_pagamento,note") \
        .gte("data_pagamento", start) \
        .lte("data_pagamento", end) \
        .order("data_pagamento") \
        .execute()

    return jsonify(response.data or [])


def _costruisci_payload_pagamento(data):
    data = data or {}

    cliente_id = str(data.get("cliente_id") or "").strip()
    cliente = (data.get("cliente") or "").strip()
    data_pagamento = (data.get("data_pagamento") or "").strip()
    note = (data.get("note") or "").strip()
    importo_raw = data.get("importo")

    if cliente_id:
        cliente_row = supabase.table("clienti") \
            .select("id,nome,cognome") \
            .eq("id", cliente_id) \
            .single() \
            .execute().data

        if not cliente_row:
            return None, ("Cliente non trovato", 404)

        cliente = f"{cliente_row.get('nome', '')} {cliente_row.get('cognome', '')}".strip()

    if not cliente:
        return None, ("Cliente obbligatorio", 400)

    if not data_pagamento:
        return None, ("Data pagamento obbligatoria", 400)

    try:
        datetime.strptime(data_pagamento, "%Y-%m-%d")
    except ValueError:
        return None, ("Formato data non valido. Usa YYYY-MM-DD", 400)

    if importo_raw is None:
        return None, ("Importo obbligatorio", 400)

    try:
        importo_norm = str(importo_raw).replace(",", ".").strip()
        importo = float(importo_norm)
    except (ValueError, TypeError):
        return None, ("Importo non valido", 400)

    if importo <= 0:
        return None, ("Importo deve essere maggiore di zero", 400)

    return {
        "cliente": cliente,
        "importo": importo,
        "data_pagamento": data_pagamento,
        "note": note or None
    }, None


@app.route("/api/pagamenti", methods=["POST"])
@login_required
def crea_pagamento():
    payload, errore = _costruisci_payload_pagamento(request.json or {})
    if errore:
        return jsonify({"error": errore[0]}), errore[1]

    response = supabase.table("pagamenti").insert(payload).execute()
    pagamento = response.data[0] if response.data else payload
    return jsonify({
        "success": True,
        "pagamento": pagamento
    })


@app.route("/api/pagamenti/<pagamento_id>", methods=["PUT"])
@login_required
def aggiorna_pagamento(pagamento_id):
    payload, errore = _costruisci_payload_pagamento(request.json or {})
    if errore:
        return jsonify({"error": errore[0]}), errore[1]

    response = supabase.table("pagamenti") \
        .update(payload) \
        .eq("id", pagamento_id) \
        .execute()

    if not response.data:
        return jsonify({"error": "Pagamento non trovato"}), 404

    return jsonify({
        "success": True,
        "pagamento": response.data[0]
    })


@app.route("/api/pagamenti/<pagamento_id>", methods=["DELETE"])
@login_required
def elimina_pagamento(pagamento_id):
    response = supabase.table("pagamenti") \
        .delete() \
        .eq("id", pagamento_id) \
        .execute()

    if not response.data:
        return jsonify({"error": "Pagamento non trovato"}), 404

    return jsonify({"success": True})

# ===============================
# ARCHIVIO CLIENTI
# ===============================

@app.route("/clienti")
@login_required
def lista_clienti():
    response = supabase.table("clienti") \
        .select("id,nome,cognome,telefono,email") \
        .order("cognome") \
        .execute()

    return render_template("clienti.html", clienti=response.data)


@app.route("/pagamenti")
@login_required
def pagina_pagamenti():
    return render_template("pagamenti.html")

# ===============================
# DETTAGLIO CLIENTE
# ===============================

@app.route("/cliente/<cliente_id>")
@login_required
def dettaglio_cliente(cliente_id):

    cliente = supabase.table("clienti") \
        .select("*") \
        .eq("id", cliente_id) \
        .single() \
        .execute().data

    tipi_pacchetto = supabase.table("tipi_pacchetto") \
        .select("*, servizi(nome)") \
        .execute().data

    pacchetti_cliente = supabase.table("pacchetti_cliente") \
        .select("*, tipi_pacchetto(nome, numero_sedute)") \
        .eq("cliente_id", cliente_id) \
        .eq("stato", "attivo") \
        .execute().data
    
    for pac in pacchetti_cliente:
        pac["sedute_rimanenti"] = max(0,
            pac["tipi_pacchetto"]["numero_sedute"] - (pac["sedute_effettuate"] or 0))

    now = datetime.now().isoformat()

    # Recupero appuntamenti tramite tabella ponte
    relazioni = supabase.table("appuntamenti_clienti") \
        .select("appuntamento_id") \
        .eq("cliente_id", cliente_id) \
        .execute().data

    appuntamenti_ids = [r["appuntamento_id"] for r in relazioni]

    # Evita errore se lista vuota
    if not appuntamenti_ids:
        appuntamenti_ids = ["00000000-0000-0000-0000-000000000000"]

    appuntamenti_raw = supabase.table("appuntamenti") \
        .select("*, servizi(nome), appuntamenti_clienti(cliente_id, clienti(nome,cognome))") \
        .in_("id", appuntamenti_ids) \
        .gte("start_datetime", now) \
        .order("start_datetime") \
        .execute().data

    appuntamenti = []

    for appo in appuntamenti_raw:
        dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
        data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")

        condivisi = []

        for rel in appo.get("appuntamenti_clienti", []):
            cid = rel.get("cliente_id")
            cliente_rel = rel.get("clienti")

            if cid and str(cid) != str(cliente_id) and cliente_rel:
                condivisi.append(f"👤 {cliente_rel['nome']} {cliente_rel['cognome']}")

        appuntamenti.append({
            "id": appo["id"],
            "data_formattata": data_formattata,
            "servizio": appo["servizi"]["nome"],
            "stato": appo["stato"],
            "condivisi": condivisi
        })

    # ===============================
    # STORICO COMPLETO APPUNTAMENTI
    # ===============================

    storico_raw = supabase.table("appuntamenti") \
        .select("*, servizi(nome), appuntamenti_clienti(cliente_id, clienti(nome,cognome))") \
        .in_("id", appuntamenti_ids) \
        .order("start_datetime", desc=True) \
        .execute().data

    storico_appuntamenti = []

    totale_sedute = 0
    ultima_visita = None
    prossima_visita = None

    now_dt = datetime.now()

    for appo in storico_raw:
        dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
        data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")

        condivisi = []
        for rel in appo.get("appuntamenti_clienti", []):
            cid = rel.get("cliente_id")
            cliente_rel = rel.get("clienti")
            if cid and str(cid) != str(cliente_id) and cliente_rel:
                condivisi.append(f"👤 {cliente_rel['nome']} {cliente_rel['cognome']}")

        storico_appuntamenti.append({
            "id": appo["id"],
            "data_formattata": data_formattata,
            "servizio": appo["servizi"]["nome"],
            "stato": appo.get("stato"),
            "numero_seduta": appo.get("numero_seduta"),
            "note": (appo.get("note") or "").strip(),
            "condivisi": condivisi
        })

        # Calcolo totale sedute (basato su numero_seduta)
        if appo.get("numero_seduta"):
            totale_sedute += 1

        # Ultima visita (passata più recente)
        if dt <= now_dt:
            if not ultima_visita or dt > ultima_visita:
                ultima_visita = dt

        # Prossima visita (futura più vicina)
        if dt > now_dt:
            if not prossima_visita or dt < prossima_visita:
                prossima_visita = dt

    ultima_visita_str = ultima_visita.strftime("%d/%m/%Y") if ultima_visita else None
    prossima_visita_str = prossima_visita.strftime("%d/%m/%Y") if prossima_visita else None

    # Sedute rimanenti (somma pacchetti attivi)
    sedute_rimanenti = sum(pac.get("sedute_rimanenti", 0) for pac in pacchetti_cliente)

    nome_cliente_pagamenti = f"{cliente.get('nome', '')} {cliente.get('cognome', '')}".strip()

    pagamenti_raw = supabase.table("pagamenti") \
        .select("cliente,importo,data_pagamento,note") \
        .eq("cliente", nome_cliente_pagamenti) \
        .order("data_pagamento", desc=True) \
        .execute().data or []

    def parse_importo_pagamento(value):
        if isinstance(value, (int, float)):
            return float(value)

        raw = str(value or "").strip().replace("€", "").replace(" ", "")
        if raw.count(",") == 1 and raw.count(".") >= 1:
            raw = raw.replace(".", "").replace(",", ".")
        elif "," in raw:
            raw = raw.replace(",", ".")

        try:
            return float(raw)
        except (TypeError, ValueError):
            return 0.0

    pagamenti_cliente = []
    totale_pagamenti = 0.0

    for pagamento in pagamenti_raw:
        importo_value = parse_importo_pagamento(pagamento.get("importo"))
        totale_pagamenti += importo_value

        data_value = pagamento.get("data_pagamento")
        try:
            data_dt = datetime.fromisoformat(str(data_value).replace("Z", "+00:00"))
            data_formattata = data_dt.strftime("%d/%m/%Y")
        except (TypeError, ValueError):
            data_formattata = data_value or "-"

        importo_label = f"€ {importo_value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

        pagamenti_cliente.append({
            "cliente": pagamento.get("cliente") or "-",
            "data_formattata": data_formattata,
            "importo": importo_value,
            "importo_label": importo_label,
            "note": pagamento.get("note") or "-"
        })

    totale_pagamenti_label = f"€ {totale_pagamenti:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    ultimo_pagamento_data = pagamenti_cliente[0]["data_formattata"] if pagamenti_cliente else None

    return render_template(
        "cliente_dettaglio.html",
        cliente=cliente,
        appuntamenti=appuntamenti,
        tipi_pacchetto=tipi_pacchetto,
        pacchetti_cliente=pacchetti_cliente,
        storico_appuntamenti=storico_appuntamenti,
        stats_totali=totale_sedute,
        stats_rimanenti=sedute_rimanenti,
        ultima_visita=ultima_visita_str,
        prossima_visita=prossima_visita_str,
        pagamenti_cliente=pagamenti_cliente,
        pagamenti_totale_label=totale_pagamenti_label,
        pagamenti_count=len(pagamenti_cliente),
        pagamenti_ultimo=ultimo_pagamento_data
    )


# ===============================
# ASSEGNA PACCHETTO
# ===============================

@app.route("/assegna_pacchetto", methods=["POST"])
@login_required
def assegna_pacchetto():

    cliente_id = request.form["cliente_id"]
    tipo_pacchetto_id = request.form["tipo_pacchetto_id"]

    assegna_pacchetto_a_cliente(cliente_id, tipo_pacchetto_id)
    invalidate_dashboard_caches()

    return redirect(f"/cliente/{cliente_id}")


# ===============================
# SALVA NOTE
# ===============================

@app.route("/cliente/<cliente_id>/note", methods=["POST"])
@login_required
def aggiorna_note(cliente_id):

    note = request.form.get("note_cliniche")

    supabase.table("clienti") \
        .update({"note_cliniche": note}) \
        .eq("id", cliente_id) \
        .execute()

    return redirect(f"/cliente/{cliente_id}")

# ===============================
# GENERA PDF PROMEMORIA
# ===============================

@app.route("/cliente/<cliente_id>/promemoria")
@login_required
def genera_promemoria(cliente_id):

    cliente = supabase.table("clienti") \
        .select("*") \
        .eq("id", cliente_id) \
        .single() \
        .execute().data

    now = datetime.now().isoformat()

    # Include appuntamenti condivisi (tabella ponte) + fallback legacy (cliente_id diretto)
    relazioni = supabase.table("appuntamenti_clienti") \
        .select("appuntamento_id") \
        .eq("cliente_id", cliente_id) \
        .execute().data or []

    appuntamenti_ids = {
        rel.get("appuntamento_id")
        for rel in relazioni
        if rel.get("appuntamento_id")
    }

    legacy_rows = supabase.table("appuntamenti") \
        .select("id") \
        .eq("cliente_id", cliente_id) \
        .gte("start_datetime", now) \
        .execute().data or []

    for row in legacy_rows:
        app_id = row.get("id")
        if app_id:
            appuntamenti_ids.add(app_id)

    appuntamenti_raw = []
    if appuntamenti_ids:
        appuntamenti_raw = supabase.table("appuntamenti") \
            .select("*, servizi(nome)") \
            .in_("id", list(appuntamenti_ids)) \
            .gte("start_datetime", now) \
            .order("start_datetime") \
            .execute().data or []

    appuntamenti_raw.sort(key=lambda appo: appo.get("start_datetime", ""))

    buffer = BytesIO()
    doc = SimpleDocTemplate(buffer, pagesize=A4)
    elements = []
    styles = getSampleStyleSheet()

    elements.append(Paragraph(
        "<b>MASSOTERAPIA & PT di Christian Di Tommaso</b>",
        styles["Heading1"]
    ))
    elements.append(Spacer(1, 0.3 * inch))

    elements.append(Paragraph("Promemoria Appuntamenti", styles["Heading2"]))
    elements.append(Spacer(1, 0.3 * inch))

    elements.append(Paragraph(
        f"<b>Cliente:</b> {cliente['nome']} {cliente['cognome']}",
        styles["Normal"]
    ))
    elements.append(Spacer(1, 0.3 * inch))

    lista = []

    for appo in appuntamenti_raw:
        dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
        data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")
        testo = f"{data_formattata} - {appo['servizi']['nome']}"
        lista.append(ListItem(Paragraph(testo, styles["Normal"])))

    if not lista:
        elements.append(Paragraph("Nessun appuntamento futuro registrato.", styles["Normal"]))
    else:
        elements.append(ListFlowable(lista, bulletType="bullet"))
    elements.append(Spacer(1, 0.5 * inch))

    oggi = datetime.now().strftime("%d/%m/%Y")
    elements.append(Paragraph(f"Documento generato il {oggi}", styles["Italic"]))

    doc.build(elements)
    buffer.seek(0)

    return send_file(
        buffer,
        as_attachment=False,
        download_name="promemoria_appuntamenti.pdf",
        mimetype="application/pdf"
    )

@app.route("/update_stato", methods=["POST"])
@login_required
def update_stato():
    appuntamento_id = (request.form.get("appuntamento_id") or "").strip()
    stato = (request.form.get("stato") or "").strip()
    allowed_stati = {"prenotato", "completato", "annullato", "svolto", "no_show"}

    if not appuntamento_id or not stato:
        app.logger.warning(
            "update_stato payload incompleto appuntamento_id=%s stato=%s",
            appuntamento_id,
            stato
        )
        return redirect(request.referrer or "/")

    if stato not in allowed_stati:
        app.logger.warning(
            "update_stato stato non valido appuntamento_id=%s stato=%s",
            appuntamento_id,
            stato
        )
        return redirect(request.referrer or "/")

    response = package_operation(supabase, "update", {"id": appuntamento_id, "changes": {"stato": stato}})

    if not response.get("appuntamenti"):
        app.logger.warning("update_stato appuntamento non trovato id=%s", appuntamento_id)

    invalidate_calendar_cache()
    invalidate_dashboard_caches()
    return redirect(request.referrer or "/")

@app.route("/chiudi_pacchetto/<pacchetto_id>", methods=["POST"])
@login_required
def chiudi_pacchetto(pacchetto_id):

    package_operation(supabase, "close", {"id": pacchetto_id})
    invalidate_dashboard_caches()

    return redirect(request.referrer)




# ===============================
# INVIO PROMEMORIA EMAIL
# ===============================


@app.route("/invia_promemoria/<appuntamento_id>", methods=["GET"])
@login_required
def invia_promemoria(appuntamento_id):
    # Recupero appuntamento con servizio e clienti
    appo = supabase.table("appuntamenti") \
        .select("""
            *,
            servizi(nome),
            appuntamenti_clienti(
                cliente_id,
                clienti(nome,cognome,email)
            )
        """) \
        .eq("id", appuntamento_id) \
        .single() \
        .execute().data

    if not appo:
        return jsonify({"status": "error", "message": "Appuntamento non trovato"}), 404

    relazioni = appo.get("appuntamenti_clienti", [])

    if not relazioni:
        return jsonify({"status": "error", "message": "Cliente non associato"}), 400

    cliente = relazioni[0].get("clienti")

    if not cliente or not cliente.get("email"):
        return jsonify({"status": "error", "message": "Email cliente non disponibile"}), 400

    dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
    data_formattata = dt.strftime("%d/%m/%Y")
    ora_formattata = dt.strftime("%H:%M")

    servizio_nome = appo["servizi"]["nome"]
    numero_seduta = appo.get("numero_seduta")

    info_seduta = ""
    if numero_seduta:
        info_seduta = f"\nQuesta sarà la seduta n° {numero_seduta} del tuo pacchetto.\n"

    corpo = f"""
Ciao {cliente['nome']},

Ti ricordo il tuo appuntamento:

Data: {data_formattata}
Orario: {ora_formattata}
Servizio: {servizio_nome}
{info_seduta}
Ti aspetto!

MASSOTERAPIA & PT
Christian Di Tommaso
"""

    esito = invia_email_dettagliata(cliente["email"], f"Promemoria Appuntamento – {servizio_nome}", corpo)
    if esito["success"]:
        return jsonify({"status": "success"})

    return jsonify({"status": "error", "message": esito["message"], "error_code": esito["error_code"]}), 500


# ===============================
# AVVIO SERVER
# ===============================

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=True)
