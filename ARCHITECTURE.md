# Struttura del gestionale

Primo intervento di separazione, 3 novembre 2026: estrazione dei servizi email e
calendario personale. L'applicazione rimane Flask, con lo stesso avvio
`gunicorn app:app` e lo stesso frontend.

## Moduli

| File | Responsabilità |
| --- | --- |
| `app.py` | Configurazione Flask, autenticazione, CSRF, rotte e composizione dei servizi. |
| `services/mail_transport.py` | Trasporto Gmail/Resend, allegati e classificazione controllata degli errori. |
| `services/calendar_files.py` | Generazione ICS, timezone Europe/Rome, escape, piegatura delle righe e nomi dei file. |
| `services/appointment_notifications.py` | Conferme per destinatario, dati delle sedute e coordinamento con il tracciamento. |
| `email_tracking.py` | Stato persistente delle conferme e aggiornamenti compare-and-swap. |
| `package_accounting.py` | Adattatore delle operazioni transazionali di pacchetti e appuntamenti. |
| `login_security.py` | Configurazione delle sessioni, verifica credenziali e limitazione dei tentativi. |

`AppointmentNotifications` riceve esplicitamente database, logger e funzione di
invio. Non importa l'app Flask né costruisce connessioni Supabase. Il piccolo
adattatore `invia_conferme_appuntamento` in app.py fornisce le dipendenze correnti
per ogni chiamata, evitando di catturare un vecchio client durante i test.

I moduli di trasporto e generazione ICS si possono importare senza credenziali,
contesto Flask, registrazione di rotte o avvio del server. `services/__init__.py`
non produce effetti collaterali. Il trasporto legge le stesse variabili ambiente
al momento dell'invio; i nomi e i criteri di selezione del provider sono conservati.
I log del trasporto usano il logger del modulo e gli stessi filtri di richiesta.

## Compatibilità verificata

- Confronto di tutte le 39 rotte: percorso, metodi HTTP ed endpoint identici.
- Confronto AST delle funzioni spostate: stessa logica, normalizzando soltanto i
  riferimenti alle dipendenze ora iniettate nell'oggetto servizio.
- Contenuto testuale delle email, messaggi controllati, dati dei file ICS e nomi
  degli allegati conservati. Nessuna modifica alle regole di reinvio o agli esiti incerti.
- Test aggiornati per sostituire i trasporti nel modulo che ora li contiene,
  mantenendo le stesse asserzioni e il blocco degli invii reali.
- Server browser aggiornato per bloccare i trasporti nella nuova posizione.

Esito locale: **244 test Python, 90 test JavaScript e 21 test browser superati**.
La suite browser ha verificato Chromium, WebKit desktop e WebKit mobile con
dati sintetici e trasporti bloccati; nessun invio reale o scrittura in produzione.

Non occorrono migrazioni del database, nuove dipendenze o cambiamenti alle
variabili Render. I sorgenti sotto services/ devono essere pubblicati insieme ad
app.py; non pubblicare soltanto il file principale.

## Verifiche ripetibili

```sh
python3 -m pytest -q --disable-warnings
npm run test:unit
npm run test:e2e
```

Per usare un interprete isolato con le stesse librerie di Render:

```sh
E2E_PYTHON="/percorso/python-3.14.3/bin/python" npm run test:e2e
```

Vedere TESTING.md per preparazione dei browser, isolamento dei dati e workflow CI.
I test di email verificano trasporti simulati e allegati, senza consegna reale.

## Passi successivi

Agenda, clienti e pagamenti sono ancora registrati in app.py. Conviene estrarre
una sezione alla volta, conservando gli URL e ripetendo le verifiche dopo ogni
intervento. La riorganizzazione di queste sezioni non è inclusa in questo primo
passaggio. Le funzionalità dei pagamenti restano quelle attuali.
