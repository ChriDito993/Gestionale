# Verifiche del gestionale

Verifica del 3 novembre 2026: **21 test browser superati** (7 flussi sui tre
profili, senza retry), **244 test Python** e **90 test JavaScript** superati.
La suite browser è stata eseguita con Python 3.14.3 e le dipendenze di Render.
Il workflow GitHub è predisposto ma va ancora pubblicato per eseguirsi in CI.

## Test automatici nel browser

La suite Playwright usa Chromium desktop, WebKit desktop e WebKit in formato
iPhone 13 (viewport, input touch, timezone Europe/Rome). WebKit è il motore di
Safari: questi test non sostituiscono una verifica su Safari o su un iPhone reale.

I flussi coperti sono:

- Credenziali errate, accesso valido, cookie HttpOnly/SameSite e logout.
- Creazione di un cliente, ricerca con accenti, vista lista, modifica anagrafica
  e salvataggio delle note con ricarica della pagina.
- Creazione di un appuntamento di coppia, entrambe le persone in agenda,
  modifica, annullamento della conferma di eliminazione e cancellazione confermata.
- Annullamento dell'avviso di sovrapposizione, senza creare altri appuntamenti.
- Rifiuto di richieste senza CSRF; GET non può inviare promemoria o effettuare logout.
- Viste giorno/settimana; wheel orizzontale di navigazione su desktop e layout mobile.
- Agenda indisponibile: errore visibile, creazione bloccata, recupero con Riprova.

Le azioni passano dal browser reale alle rotte Flask reali, con sessione e controlli
CSRF abilitati. Soltanto database e trasporti esterni sono simulati. Il test verifica
anche stato del backend dopo i salvataggi e dopo la ricarica della pagina.

La logica transazionale PostgreSQL dei pacchetti resta coperta separatamente dalle
prove SQL documentate in PACKAGE_ACCOUNTING.md: il doppio del database qui non
pretende di verificarne transazioni, RLS o vincoli reali.

## Preparazione ed esecuzione

Dalla cartella del progetto, con Node.js 24.13.1 e un Python che abbia le dipendenze
installate (vedere DEPENDENCIES.md):

```sh
npm ci --ignore-scripts
npx playwright install chromium webkit
npm run test:e2e
```

Per selezionare un interprete Python isolato:

```sh
E2E_PYTHON="/percorso/ambiente/bin/python" npm run test:e2e
```

Per un solo browser o per aprire il report:

```sh
npm run test:e2e -- --project=chromium-desktop
npm run test:e2e:report
```

La suite avvia e ferma autonomamente il server su **127.0.0.1:39781**. Se la porta è
occupata, fallisce anziché riusare un servizio sconosciuto. Il gestionale locale
sulla porta 5050 non viene usato. Non esiste un parametro per puntare la suite
al servizio Render o a un database di produzione.

I browser scaricati durante lo sviluppo iniziale sono sotto
`/tmp/gestionale-playwright-browsers`; per riusarli temporaneamente impostare
`PLAYWRIGHT_BROWSERS_PATH=/tmp/gestionale-playwright-browsers`. La preparazione
standard sopra li installa invece nella cache normale di Playwright.

## Isolamento

`tests/e2e/server.py` è un esecutore dedicato, non importato da app.py o dal Procfile.
Prima di importare l'app imposta esclusivamente configurazione sintetica e
impedisce il caricamento del `.env`. La costruzione del client Supabase è sostituita
prima dell'import; database e relazioni vivono soltanto in memoria e sono azzerati
prima di ogni caso. Gli endpoint `/__e2e__/...` esistono solo in questo esecutore.

Le connessioni Python esterne e i trasporti email sono bloccati. Il browser può
contattare soltanto il server di test; il bundle FullCalendar 6.1.15 del CDN viene
servito dal pacchetto npm locale della medesima versione. Altre richieste esterne,
errori JavaScript inattesi o tentativi di invio email fanno fallire il test.

La conferma email viene esplicitamente disattivata nelle prenotazioni di prova.
Tutti i clienti, indirizzi e note sono sintetici. Screenshot, trace e report
contengono solo questi dati. Non servono segreti Supabase o Render per eseguire
la suite; non inserire credenziali reali nella configurazione di test.

## Esecuzione su GitHub

`.github/workflows/browser-tests.yml` avvia test Python, JavaScript e browser su
push/PR verso main e consente l'avvio manuale in Actions. Usa il Python fissato
in `.python-version`, dipendenze con hash, npm ci e azioni ufficiali fissate a
commit immutabili. Il token GitHub ha soltanto `contents: read`; il job non usa
segreti applicativi, non pubblica codice e non esegue deploy.

Il report Playwright è disponibile come artifact per sette giorni. Trace e
screenshot dei fallimenti sono inclusi nel report. In CI è previsto al massimo
un retry per aiutare a distinguere problemi intermittenti: un caso flaky resta
segnalato nel report e va investigato.

L'esecuzione CI viene attivata quando il workflow è pubblicato su GitHub. Non
modifica l'auto-deploy Render e non imposta protezioni del branch: il controllo
non blocca da solo un deploy automatico già configurato.

## Altri controlli

```sh
python3 -m pytest -q --disable-warnings
npm run test:unit
```

Il profilo locale Python e quello online sono distinti: per ripetere le prove
con le librerie di Render usare un ambiente Python 3.14.3 con requirements.txt.

## Correzione emersa durante la preparazione

È stato eliminato il link a `fullcalendar@6.1.15/main.min.css`: il pacchetto v6 non
contiene quel file e il bundle globale JavaScript include già gli stili. Nessun
aggiornamento della versione del calendario. Riferimento ufficiale:
[gestione CSS in FullCalendar 6](https://legacy.fullcalendar.io/v6/upgrading-from-v5#bundlers--css).

Riferimenti Playwright: [server locale](https://playwright.dev/docs/test-webserver)
e [progetti browser](https://playwright.dev/docs/test-projects).
