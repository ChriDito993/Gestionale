# Protezione delle tabelle del gestionale

Intervento applicato al progetto collegato il 22 ottobre 2026.

## Modello di accesso

Il browser comunica con il backend Flask, non direttamente con il database.
Il login del gestionale resta il controllo di accesso applicativo. Il backend
usa `SUPABASE_URL` e una Secret key in `SUPABASE_KEY`, impostata nel `.env`
locale e nelle variabili del servizio Render. La chiave privata non deve mai
essere pubblicata nel frontend, nei log o su Git.

Sulle tabelle `clienti`, `appuntamenti`, `appuntamenti_clienti`,
`pacchetti_cliente`, `tipi_pacchetto`, `servizi`, `pagamenti`:

- RLS è attiva.
- I privilegi di `PUBLIC`, `anon` e `authenticated` sono revocati.
- I privilegi esistenti del backend `service_role` sono conservati, inclusi
  lettura, inserimento, modifica e cancellazione.
- Nessuna policy permette accesso diretto dal browser. L'assenza di policy è
  intenzionale per questo modello backend-only: la Secret key usa un ruolo che
  bypassa RLS, quindi il controllo del login Flask rimane fondamentale.

Le modifiche non alterano i dati delle tabelle né la logica di pacchetti,
appuntamenti, conferme email o pagamenti. Non sostituiscono un audit completo
di autenticazione, sessioni e sicurezza dell'applicazione.

## Intervento e ripristino

Su Supabase sono registrate due migrazioni, applicate in sequenza per controllare
prima il funzionamento di Render sulla sola tabella dei servizi:

1. `restrict_services_to_backend`.
2. `restrict_management_tables_to_backend`.

`sql/backend_only_access.sql` contiene l'equivalente completo e ripetibile per
altri ambienti. Applicarlo solo dopo avere configurato e verificato la Secret
key del backend. Sul progetto collegato è **già applicato**: non occorre
eseguirlo durante un normale deploy.

`sql/rollback_backend_only_access.sql` ripristina lo stato precedente verificato,
ma **riapre l'accesso pubblico**. È riservato a un ripristino di emergenza
consapevole; non eseguirlo come parte del deploy. In caso di problemi, verificare
prima la Secret key in Render e l'avvenuto riavvio del servizio.

## Backup locale

La cartella `.backups/pre-rls-20261022-mvjbg397/` contiene:

- `access-before.json`: colonne, vincoli, privilegi e stato RLS precedenti.
- Un file JSON con i dati di ciascuna delle sette tabelle.
- `manifest.json`: quantità di righe e checksum SHA-256 dei file esportati.

Sono stati verificati checksum, quantità di righe e assenza di ID duplicati.
Le cartelle hanno permessi `700`, i file `600`; `.backups/` è esclusa da Git.
Il backup contiene dati personali in chiaro: conservarlo su un dispositivo
protetto e non condividerlo né aggiungerlo al repository.

È un'esportazione logica tramite Data API, **non** un `pg_dump` completo o uno
snapshot transazionale tra tabelle. Non include Auth, Storage o altre risorse
del progetto. Le modifiche ai permessi non hanno riscritto o cancellato righe.
Per esigenze di disaster recovery predisporre anche un backup completo gestito.

Lo script `scripts/backup_supabase_tables.py` permette nuove esportazioni in una
nuova sottocartella privata di `.backups/` contenente prima il relativo snapshot
`access-before.json`; rifiuta la sovrascrittura dei file esistenti.

## Verifiche eseguite

- Accesso al database con la Secret key locale: lettura delle sette tabelle.
- Controlli HTTP HEAD del backend su Render dopo entrambe le fasi: login,
  clienti, calendario, pacchetti, servizi e dati pagamenti conservati.
- Richieste HTTP HEAD dirette con entrambe le chiavi pubbliche attive (legacy
  anon e nuova publishable): lettura negata su tutte le sette tabelle.
- Privilegi verificati nel database: nessun accesso CRUD per `anon` o
  `authenticated`; accesso CRUD del backend conservato.
- Nessuna prenotazione di prova creata, nessuna email o messaggio inviato.

Controlli ripetibili:

```sh
python3 scripts/check_deployed_read_access.py
python3 scripts/check_anonymous_api_access.py
python3 -m pytest -q --disable-warnings
node --test tests/test_workflow_frontend.js
```

Il secondo script legge da stdin un array JSON di sole chiavi pubbliche,
disabilitandone l'eco sul terminale; non usare Secret key. I due controlli online
non stampano credenziali, contenuti delle risposte o dati dei clienti.

## Segnalazioni e manutenzione

Il Security Advisor non segnala più `RLS Disabled in Public` sulle sette tabelle.
Può mostrare l'avviso informativo **RLS Enabled No Policy**: è atteso per questo
modello. Non risolverlo aggiungendo policy `USING (true)` per i ruoli pubblici.

Resta separata la segnalazione preesistente sulla protezione delle password
compromesse di Supabase Auth: questo intervento non cambia Supabase Auth né il
login amministrativo Flask e non pretende di risolvere quella configurazione.

Le impostazioni dei privilegi predefiniti per tabelle future non sono state
cambiate. Ogni nuova tabella va protetta esplicitamente con RLS e privilegi
minimi coerenti con questo modello prima di essere usata.

Riferimenti ufficiali:

- [Sicurezza della Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [RLS attiva senza policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy)
- [Protezione delle password Supabase Auth](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
