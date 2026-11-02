# Sicurezza del login

## Configurazione

Il server rifiuta l'avvio se manca `SECRET_KEY`, se è vuota o coincide con il
vecchio valore predefinito. Richiede inoltre `ADMIN_EMAIL` e una password o hash.
Non registrare né pubblicare questi valori.

In Render configurare:

- `SECRET_KEY`: segreto casuale, generato con `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'`.
- `ADMIN_EMAIL`: indirizzo amministrativo esistente.
- `ADMIN_PASSWORD_HASH`: hash generato con il comando sotto.
- `SESSION_COOKIE_SECURE=true`: valore predefinito, richiede HTTPS.

Generare l'hash senza scrivere la password nel comando o nella cronologia:

```sh
python3 -c 'from getpass import getpass; from login_security import password_hash; print(password_hash(getpass("Password: ")))'
```

Dopo aver configurato `ADMIN_PASSWORD_HASH`, rimuovere `ADMIN_PASSWORD` da Render.
L'hash ha precedenza. Per compatibilità `ADMIN_PASSWORD` è ancora accettata:
viene trasformata in hash all'avvio e le verifiche usano Werkzeug PBKDF2-SHA256
con 1.000.000 iterazioni. La password non viene salvata nella sessione.

Per lavorare su `http://127.0.0.1:5050` impostare esplicitamente
`SESSION_COOKIE_SECURE=false` nel proprio `.env`; non disabilitarlo in produzione.
L'avvio diretto usa localhost e non abilita il debugger.

Cambiare SECRET_KEY invalida tutte le sessioni: dopo il deploy sarà necessario
accedere nuovamente. Cambiare soltanto la password non revoca le sessioni già
emesse: per revocarle cambiare anche SECRET_KEY.

## Comportamento

- Cookie HttpOnly e SameSite=Lax, Secure per impostazione predefinita.
- Login protetto da token CSRF associato alla sessione del browser.
- Dopo l'accesso la sessione precedente è cancellata; durata massima 8 ore,
  senza rinnovo a ogni richiesta.
- Risposte del login e delle sessioni autenticate con Cache-Control: no-store.
- Massimo 10 invii con token valido in 15 minuti per indirizzo osservato dal
  server, poi HTTP 429 con Retry-After. Anche gli accessi riusciti contano.
  Un token mancante o errato dà HTTP 400 prima di verificare le credenziali.
- Email errata e password errata producono lo stesso messaggio.

## Limiti e passi successivi

Il limitatore usa SQLite, condiviso tra i worker Gunicorn dello stesso host.
`LOGIN_RATE_LIMIT_DB` consente di scegliere il percorso del file (directory privata
scrivibile dall'app). Per impostazione predefinita è nella directory temporanea:
riavvii/deploy possono azzerarlo. Il database conserva soltanto hash degli indirizzi
e orari degli ultimi 15 minuti; non contiene email o password.

Non si accetta X-Forwarded-For dal client. Dietro un reverse proxy gli operatori
possono condividere il limite: verificare la topologia Render prima di introdurre
fiducia negli header del proxy. Per più istanze occorre un archivio condiviso
come Redis o un limite gestito dal proxy: SQLite locale non coordina host diversi.

Il token CSRF introdotto qui protegge il login. Le altre operazioni del gestionale
richiedono un intervento separato per introdurre token in tutti i form e nelle
richieste JavaScript. SameSite=Lax è una difesa aggiuntiva, non un sostituto.
La rotta GET che invia promemoria rimane da convertire a POST in quell'intervento.
Non sono stati introdotti MFA, recupero password o utenti multipli.

## Verifiche

```sh
python3 -m pytest -q --disable-warnings
node --test tests/test_workflow_frontend.js
```

I test includono token mancanti, falsificati e di un altro browser, credenziali
errate, pulizia della sessione, limite condiviso e scadenza della finestra.
Non eseguono accessi al database reale o invii di email.

Riferimenti: [sicurezza Flask](https://flask.palletsprojects.com/en/stable/web-security/)
e [hashing Werkzeug](https://werkzeug.palletsprojects.com/en/stable/utils/#module-werkzeug.security).
