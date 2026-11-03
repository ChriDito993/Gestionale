"""Appointment confirmations with explicit database, logger and delivery dependencies."""
from datetime import datetime

from email_tracking import ConfirmationStore, confirmation_fingerprint
from .calendar_files import genera_file_calendario, nome_file_calendario
from .mail_transport import EMAIL_ERROR_MESSAGES


class AppointmentNotifications:
    def __init__(self, database, logger, send_email):
        self.database = database
        self.logger = logger
        self.send_email = send_email

    def recupera_dati_pacchetto(self, pacchetto_id):
        if not pacchetto_id:
            return None

        try:
            response = self.database.table("pacchetti_cliente") \
                .select("cliente_id,tipi_pacchetto(numero_sedute)") \
                .eq("id", pacchetto_id) \
                .single() \
                .execute()
            pacchetto = response.data or {}
            totale_sedute = (pacchetto.get("tipi_pacchetto") or {}).get("numero_sedute")
            if pacchetto.get("cliente_id") and totale_sedute:
                return {"cliente_id": pacchetto["cliente_id"], "totale_sedute": totale_sedute}
        except Exception:
            self.logger.exception("Impossibile recuperare i dati del pacchetto per l'email di conferma")
        return None

    def prenota_conferma(self, appuntamento, cliente, allow_uncertain=False):
        try:
            return ConfirmationStore(self.database).claim(
                appuntamento["id"], cliente["id"], confirmation_fingerprint(appuntamento, cliente.get("email")), allow_uncertain
            )
        except Exception:
            self.logger.warning("Stato conferma non disponibile code=tracking_unavailable")
            return {"acquired": False, "reason": "tracking_unavailable"}

    def registra_esito_conferma(self, appuntamento, cliente, claim, risultato):
        try:
            code = risultato.get("error_code")
            status = "sent" if risultato["success"] else "unknown" if code in {"timeout", "delivery_unknown"} else "failed"
            if code == "missing_email":
                status = "missing_email"
            ConfirmationStore(self.database).finish(
                appuntamento["id"], cliente["id"], claim["attempt_id"], status, code, risultato.get("provider")
            )
            return True
        except Exception:
            self.logger.warning("Salvataggio stato conferma non riuscito code=tracking_unavailable")
            return False

    def invia_conferme_appuntamento(self, appuntamenti, clienti_ids, servizio_id, allow_uncertain=False):
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
            servizio_response = self.database.table("servizi") \
                .select("nome") \
                .eq("id", servizio_id) \
                .single() \
                .execute()
            servizio_nome = (servizio_response.data or {}).get("nome")
        except Exception:
            self.logger.exception("Impossibile recuperare il servizio per l'email di conferma")
            esito["failed_count"] = len(appuntamenti) * len(clienti_ids)
            return esito

        if not servizio_nome:
            self.logger.warning("Email di conferma non inviata: servizio non disponibile")
            esito["failed_count"] = len(appuntamenti) * len(clienti_ids)
            return esito

        clienti_con_email = []
        for cliente_id in clienti_ids:
            try:
                cliente_response = self.database.table("clienti") \
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
                self.logger.exception("Impossibile recuperare il cliente per l'email di conferma")
                esito["failed_count"] += len(appuntamenti)

        for appuntamento in appuntamenti:
            try:
                inizio = datetime.fromisoformat(appuntamento["start_datetime"].replace("Z", "+00:00"))
                fine = datetime.fromisoformat(appuntamento["end_datetime"].replace("Z", "+00:00"))
                dati_pacchetto = self.recupera_dati_pacchetto(appuntamento.get("pacchetto_cliente_id"))
                appuntamento_di_coppia = "coppia" in servizio_nome.casefold()

                for cliente in clienti_con_email:
                    if not (cliente.get("email") or "").strip():
                        esito["skipped_no_email_count"] += 1
                        claim = self.prenota_conferma(appuntamento, cliente, allow_uncertain)
                        if claim["acquired"]:
                            self.registra_esito_conferma(appuntamento, cliente, claim, {"success": False, "error_code": "missing_email"})
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
                    claim = self.prenota_conferma(appuntamento, cliente, allow_uncertain)
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
                    risultato_email = self.send_email(
                        cliente["email"],
                        "Conferma appuntamento – Massoterapia & PT",
                        corpo,
                        allegati=allegati
                    )
                    if not self.registra_esito_conferma(appuntamento, cliente, claim, risultato_email):
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
                        self.logger.warning("Invio conferma non riuscito appuntamento_id=%s", appuntamento.get("id"))
            except Exception:
                # L'appuntamento e' gia' stato creato: un errore email non deve annullarlo.
                esito["failed_count"] += len(clienti_con_email)
                self.logger.exception("Errore invio email di conferma appuntamento_id=%s", appuntamento.get("id"))

        return esito
