"""Transactional package/appointment mutations through one backend-only RPC."""


class PackageAccountingError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


MESSAGES = {
    "package_capacity": "Le sedute disponibili nel pacchetto non bastano. Riduci gli appuntamenti o scegli un altro pacchetto.",
    "package_closed": "Il pacchetto è chiuso o esaurito: scegli un altro pacchetto.",
    "package_expired": "Una delle date è successiva alla scadenza del pacchetto.",
    "invalid_package": "Il pacchetto non è valido per il cliente o per il servizio selezionato.",
    "invalid_booking": "Dati dell'appuntamento non validi. Controlla clienti, servizio, date e orari.",
    "invalid_operation": "Operazione non valida.",
}


def package_operation(client, action, data):
    try:
        result = client.rpc("gestionale_package_operation", {"p_action": action, "p_data": data}).execute().data
    except Exception as error:
        message = getattr(error, "message", "")
        if message in MESSAGES:
            raise PackageAccountingError(MESSAGES[message]) from None
        if getattr(error, "code", None) == "PGRST202":
            raise PackageAccountingError("Il database deve essere aggiornato prima di usare il nuovo conteggio dei pacchetti.", 503) from None
        raise PackageAccountingError("Operazione non confermata. Verifica il calendario e riprova prima di modificare altri appuntamenti.", 503) from None
    if not isinstance(result, dict):
        raise PackageAccountingError("Risposta del database non valida. Verifica il calendario prima di riprovare.", 503)
    return result
