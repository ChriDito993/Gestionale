import os
import re
import logging
import uuid
import secrets
import tempfile
from login_security import configure_session, LoginThrottle, password_hash, valid_credentials
from email_tracking import confirmation_fingerprint, sending_is_recent
from services import mail_transport
from services.appointment_notifications import AppointmentNotifications
from routes.clients import register_client_routes
from package_accounting import PackageAccountingError, package_operation
from flask import Flask, render_template, request, jsonify, redirect, session, render_template_string, url_for, g, has_request_context
from supabase import create_client
from dotenv import load_dotenv
from datetime import datetime
from zoneinfo import ZoneInfo
from calendar import monthrange
from functools import wraps
from werkzeug.exceptions import HTTPException


try:
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration
except ImportError:
    sentry_sdk = None
    FlaskIntegration = None


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

configure_session(app)

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
ADMIN_PASSWORD_HASH = os.getenv("ADMIN_PASSWORD_HASH") or (password_hash(ADMIN_PASSWORD) if ADMIN_PASSWORD else None)
if not ADMIN_EMAIL or not ADMIN_PASSWORD_HASH:
    raise RuntimeError("Impostare ADMIN_EMAIL e ADMIN_PASSWORD_HASH (oppure ADMIN_PASSWORD).")
login_throttle = LoginThrottle(os.getenv("LOGIN_RATE_LIMIT_DB", os.path.join(tempfile.gettempdir(), "gestionale-login-attempts.sqlite3")))

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
    def csrf_token():
        if "csrf_token" not in session:
            session["csrf_token"] = secrets.token_urlsafe(32)
        return session["csrf_token"]

    def static_file(filename):
        file_path = os.path.join(app.static_folder, filename)
        try:
            version = int(os.path.getmtime(file_path))
        except OSError:
            version = 0
        return url_for("static", filename=filename, v=version)

    return {"static_file": static_file, "show_payments": app.config["SHOW_PAYMENTS"], "csrf_token": csrf_token}

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


def invia_conferme_appuntamento(appuntamenti, clienti_ids, servizio_id, allow_uncertain=False):
    """Bind the current backend client and delivery transport for this request."""
    service = AppointmentNotifications(supabase, app.logger, mail_transport.invia_email_dettagliata)
    return service.invia_conferme_appuntamento(appuntamenti, clienti_ids, servizio_id, allow_uncertain)


@app.before_request
def attach_request_id():
    incoming_request_id = (request.headers.get("X-Request-ID") or "").strip()
    g.request_id = incoming_request_id[:64] if incoming_request_id else uuid.uuid4().hex[:12]


@app.before_request
def protect_authenticated_mutations():
    if request.method not in {"POST", "PUT", "PATCH", "DELETE"} or not session.get("logged_in") or request.endpoint == "login":
        return None
    expected = session.get("csrf_token")
    supplied = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
    if not expected or not secrets.compare_digest(supplied.encode(), expected.encode()):
        message = "Sessione del modulo scaduta. Ricarica la pagina e riprova."
        if request.path.startswith("/api/") or request.is_json or request.path.startswith("/invia_promemoria/"):
            return jsonify({"error": message, "message": message}), 400
        return render_template_string('<h3>Operazione non eseguita</h3><p>{{ message }}</p><a href="/">Torna al gestionale</a>', message=message), 400


@app.after_request
def add_request_id_header(response):
    if session.get("logged_in") or request.endpoint == "login":
        response.headers["Cache-Control"] = "no-store"
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

    # Salva in cache
    _dashboard_cache = {
        "timestamp": now,
        "pacchetti": totale_pacchetti_attivi,
        "clienti": 0  # The client total now belongs to the archive, not the dashboard.
    }

    return render_template(
        "index.html",
        dashboard_pacchetti=totale_pacchetti_attivi
    )

# ===============================
# LOGIN
# ===============================

@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    status = 200
    retry_after = 0
    if "login_csrf" not in session:
        session["login_csrf"] = secrets.token_urlsafe(32)
    if request.method == "POST":
        token = request.form.get("csrf_token", "")
        if not secrets.compare_digest(token.encode(), session["login_csrf"].encode()):
            error = "Sessione di accesso scaduta. Riprova dal modulo qui sotto."
            status = 400
        else:
            retry_after = login_throttle.consume(request.remote_addr or "unknown")
            if retry_after:
                error = "Troppi tentativi di accesso. Attendi qualche minuto prima di riprovare."
                status = 429
        email = request.form.get("email", "")
        password = request.form.get("password", "")
        if not error and len(email) <= 254 and len(password) <= 1024 and valid_credentials(email, password, ADMIN_EMAIL, ADMIN_PASSWORD_HASH):
            session.clear()
            session["logged_in"] = True
            session.permanent = True
            return redirect("/")
        elif not error:
            error = "Credenziali non valide"

    response = app.make_response((render_template("login.html", error=error), status))
    response.headers["Cache-Control"] = "no-store"
    if retry_after:
        response.headers["Retry-After"] = str(retry_after)
    return response

@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    return redirect("/login")


# ===============================
# API APPUNTAMENTI
# ===============================

CALENDAR_EVENT_SELECT = """
    *, servizi(nome,colore_calendario), pacchetti_cliente(sedute_totali),
    appuntamenti_clienti(cliente_id,clienti(nome,cognome))
"""


def calendar_event(appo):
    """Shared, credential-free calendar representation for agenda and next appointment."""
    links = appo.get("appuntamenti_clienti") or []
    names = [f"{link['clienti']['nome']} {link['clienti']['cognome']}" for link in links if link.get("clienti")]
    busy = appo.get("stato") == "occupato"
    service = appo.get("servizi") or {}
    title = "Occupato" if busy else service.get("nome") or ""
    if not busy and appo.get("numero_seduta"):
        title += f" (S{appo['numero_seduta']})"
    return {
        "id": appo["id"], "title": title,
        "start": appo["start_datetime"], "end": appo["end_datetime"],
        "backgroundColor": "#dc2626" if busy else service.get("colore_calendario"),
        "extendedProps": {
            "clienti": " + ".join(names),
            "clienti_ids": [link["cliente_id"] for link in links if link.get("cliente_id")],
            "servizio": service.get("nome") or "", "stato": appo.get("stato"), "occupato": busy,
            "numero_seduta": appo.get("numero_seduta"),
            "sedute_totali": (appo.get("pacchetti_cliente") or {}).get("sedute_totali"),
            "note": appo.get("note") or "", "reminder_whatsapp": appo.get("reminder_whatsapp", False)
        }
    }


def studio_now():
    """Appointment timestamps are stored as Rome wall-clock times, including on Render."""
    return datetime.now(ZoneInfo("Europe/Rome")).replace(tzinfo=None)


def counted_studio_appointment(row):
    service = " ".join(str((row.get("servizi") or {}).get("nome") or "").split()).casefold()
    return row.get("stato") not in {"occupato", "annullato"} and service not in {"check", "occupato"}


@app.route("/api/prossimo_appuntamento", methods=["GET"])
@login_required
def prossimo_appuntamento():
    now = studio_now()
    try:
        response = supabase.table("appuntamenti").select(CALENDAR_EVENT_SELECT) \
            .gt("end_datetime", now.isoformat()).in_("stato", ["prenotato", "confermato"]) \
            .order("start_datetime").order("id").limit(1).execute()
        if response.data is None:
            raise ValueError("Missing appointment response")
        event = calendar_event(response.data[0]) if response.data else None
    except Exception:
        app.logger.exception("Errore lettura prossimo appuntamento")
        return jsonify({"error": "Impossibile aggiornare il prossimo appuntamento. Riprova."}), 503
    result = jsonify({"appuntamento": event, "ora_studio": now.isoformat()})
    result.headers["Cache-Control"] = "no-store"
    return result


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
        .select(CALENDAR_EVENT_SELECT)

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
        return jsonify({"error": "Impossibile caricare il calendario. Riprova tra poco."}), 503

    if not response or response.data is None:
        app.logger.warning("Response Supabase non valida su /api/appuntamenti")
        return jsonify({"error": "Impossibile caricare il calendario. Riprova tra poco."}), 503

    eventi = []

    for appo in response.data:
        evento = calendar_event(appo)
        if cliente_query and cliente_query not in evento["extendedProps"]["clienti"].lower():
            continue
        eventi.append(evento)

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
    # Automatic for available recipients; explicit false still opts out for this booking.
    invia_conferma_raw = data.get("invia_conferma_email", True)
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
        return jsonify({"error": mail_transport.EMAIL_ERROR_MESSAGES["tracking_unavailable"]}), 503
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
            "message": mail_transport.EMAIL_ERROR_MESSAGES.get(stato.get("error_code")),
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
    from datetime import timedelta
    now_dt = studio_now()
    start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    total, offset = 0, 0
    try:
        while True:
            rows = supabase.table("appuntamenti").select("id,stato,servizi(nome)") \
                .gte("start_datetime", start.isoformat()).lt("start_datetime", end.isoformat()) \
                .order("id").range(offset, offset + 999).execute().data
            if rows is None:
                raise ValueError("Missing daily response")
            total += sum(counted_studio_appointment(row) for row in rows)
            if len(rows) < 1000:
                break
            offset += 1000
    except Exception:
        app.logger.exception("Errore conteggio appuntamenti di oggi")
        return jsonify({"error": "Impossibile aggiornare il totale di oggi."}), 503
    result = jsonify({"totale": total, "data": now_dt.date().isoformat()})
    result.headers["Cache-Control"] = "no-store"
    return result


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
# PAGINA PAGAMENTI
# ===============================


@app.route("/pagamenti")
@login_required
def pagina_pagamenti():
    return render_template("pagamenti.html")

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
# AGGIORNA STATO APPUNTAMENTO
# ===============================


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


@app.route("/invia_promemoria/<appuntamento_id>", methods=["POST"])
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

    esito = mail_transport.invia_email_dettagliata(cliente["email"], f"Promemoria Appuntamento – {servizio_nome}", corpo)
    if esito["success"]:
        return jsonify({"status": "success"})

    return jsonify({"status": "error", "message": esito["message"], "error_code": esito["error_code"]}), 500


# ===============================
# REGISTRAZIONE ROTTE CLIENTI
# ===============================

register_client_routes(
    app, login_required,
    get_database=lambda: supabase,
    studio_now=lambda: studio_now(),
    invalidate_calendar_cache=invalidate_calendar_cache,
    invalidate_dashboard_caches=invalidate_dashboard_caches,
)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False)
