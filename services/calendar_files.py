"""Personal calendar attachments; no database access or email transport."""
import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from werkzeug.utils import secure_filename


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
