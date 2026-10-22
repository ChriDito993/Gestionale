"""Read-only production smoke check. No customer data or credentials are printed."""
import logging
import os
from pathlib import Path
from datetime import datetime
from zoneinfo import ZoneInfo

import requests
from dotenv import dotenv_values


def main():
    values = dotenv_values(Path(__file__).resolve().parents[1] / ".env")
    email = os.environ.get("ADMIN_EMAIL") or values.get("ADMIN_EMAIL")
    password = os.environ.get("ADMIN_PASSWORD") or values.get("ADMIN_PASSWORD")
    if not email or not password:
        raise RuntimeError("Admin credentials required")
    base = "https://gestionale-jyzn.onrender.com"
    now = datetime.now(ZoneInfo("Europe/Rome"))
    date = now.date().isoformat()
    paths = ("/api/servizi", "/api/clienti", "/api/tipi_pacchetto", "/api/pacchetti_dashboard",
             "/api/appuntamenti?start=" + date + "T00:00:00&end=" + date + "T23:59:59",
             "/api/pagamenti/mese?mese=" + now.strftime("%Y-%m"))
    with requests.Session() as session:
        response = session.head(base + "/api/clienti", allow_redirects=False, timeout=(10, 40))
        if response.status_code != 302 or not response.headers.get("Location", "").startswith("/login"):
            raise RuntimeError("Expected login boundary")
        response = session.post(base + "/login", data={"email": email, "password": password},
                                allow_redirects=False, timeout=(10, 30))
        if response.status_code != 302 or response.headers.get("Location") != "/":
            raise RuntimeError("Production login failed")
        for path in paths:
            response = session.head(base + path, allow_redirects=False, timeout=(10, 30))
            if response.status_code != 200 or "application/json" not in response.headers.get("Content-Type", ""):
                print(path.split("?")[0] + ": HTTP " + str(response.status_code), flush=True)
                raise RuntimeError("Production read check failed")
            print(path.split("?")[0] + ": OK (HEAD)", flush=True)
    print("Verifica online completata: nessun dato scaricato, nessuna prenotazione o email creata.", flush=True)


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        main()
    except Exception as error:
        print("Verifica online fallita; tipo=" + type(error).__name__ + ". Dettagli e credenziali omessi.", flush=True)
        raise SystemExit(1)
