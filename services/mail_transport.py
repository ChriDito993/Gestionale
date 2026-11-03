"""Gmail/Resend delivery and controlled error messages; no Flask dependency."""
import base64
import logging
import os
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr

import requests

logger = logging.getLogger(__name__)


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
        logger.warning("Invio email fallito provider=%s code=%s", provider, error_code)
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
