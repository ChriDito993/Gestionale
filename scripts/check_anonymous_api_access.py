"""Check anonymous read denial using public keys supplied on stdin, never echoed."""
import json
import logging
import sys
import termios

import requests


def read_keys():
    previous = None
    if sys.stdin.isatty():
        previous = termios.tcgetattr(sys.stdin.fileno())
        hidden = list(previous)
        hidden[3] &= ~termios.ECHO
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, hidden)
    try:
        print("Pronto: lettura protetta delle chiavi pubbliche da stdin.", flush=True)
        keys = json.loads(sys.stdin.readline())
    finally:
        if previous is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSANOW, previous)
    if not isinstance(keys, list) or not keys or not all(isinstance(key, str) and key for key in keys):
        raise ValueError("Public key list required")
    if any(key.startswith("sb_secret_") for key in keys):
        raise ValueError("Public keys only")
    return keys


def main():
    keys = read_keys()
    tables = ("clienti", "appuntamenti", "appuntamenti_clienti", "pacchetti_cliente", "tipi_pacchetto", "servizi", "pagamenti")
    with requests.Session() as session:
        for index, key in enumerate(keys, start=1):
            headers = {"apikey": key, "Authorization": "Bearer " + key}
            for table in tables:
                response = session.head("https://pxgvchgntplegqqzrzkn.supabase.co/rest/v1/" + table,
                    params={"select": "id", "limit": "0"}, headers=headers, timeout=(10, 20), allow_redirects=False)
                if response.status_code not in (401, 403):
                    print(table + ": risultato inatteso HTTP " + str(response.status_code), flush=True)
                    raise RuntimeError("Anonymous access not denied")
            print("Chiave pubblica " + str(index) + ": lettura negata su tutte le 7 tabelle.", flush=True)
    print("Verifica anonima completata; nessun dato scaricato.", flush=True)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        main()
    except Exception as error:
        print("Verifica anonima fallita; tipo=" + type(error).__name__ + ". Dettagli e chiavi omessi.", flush=True)
        raise SystemExit(1)
