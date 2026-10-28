# Configurazione invio email

Impostare le variabili nel `.env` locale oppure nelle **Environment Variables**
del servizio Render. Il `.env` locale non viene pubblicato. Le variabili già
presenti nell'ambiente hanno precedenza sui valori caricati da `load_dotenv()`.

## Selezione del servizio

- `EMAIL_PROVIDER=gmail`: usa soltanto Gmail SMTP.
- `EMAIL_PROVIDER=resend`: usa soltanto le API HTTPS di Resend, anche quando
  sono ancora presenti le variabili Gmail.
- Variabile assente o vuota: mantiene la compatibilità con la configurazione
  precedente (Gmail se indirizzo e password sono presenti, altrimenti Resend).
- Un valore diverso genera un errore di configurazione senza tentare invii.

Non sono previsti fallback o reinvii automatici: in caso di timeout non sempre
è possibile sapere se il provider ha già accettato l'email.

## Gmail

- `GMAIL_EMAIL` oppure, per compatibilità, `EMAIL_USER`.
- `GMAIL_APP_PASSWORD` oppure `EMAIL_PASS`: password per app Google.
- `GMAIL_FROM_NAME`: nome mittente facoltativo.

Le variabili `GMAIL_*` hanno precedenza sugli alias `EMAIL_*`. Gli spazi nella
password per app vengono rimossi. La connessione usa `smtp.gmail.com:465` con SSL.
Render Free blocca le porte SMTP 25, 465 e 587: questa selezione non aggira il blocco.

## Resend

- `RESEND_API_KEY`: chiave API con permessi di invio.
- `RESEND_FROM_EMAIL`: mittente autorizzato, nel formato `Studio <indirizzo@dominio>`.

La connessione usa `https://api.resend.com/emails` (porta 443). Senza un mittente
esplicito viene mantenuto il valore di prova `Gestionale <onboarding@resend.dev>`:
può inviare solo all'indirizzo associato all'account Resend. Per inviare ai clienti
occorre verificare un dominio e configurare il mittente su quel dominio.

## Esito e diagnostica

Il salvataggio dell'appuntamento restituisce anche l'esito delle email e gli
eventuali messaggi di errore. Le conferme di coppia e gli allegati ICS sono
mantenuti. Un errore email non annulla la prenotazione.

L'allegato usa il nome del destinatario (ad esempio `Mario-Rossi.ics`) e, quando
la seduta appartiene a un pacchetto, il numero (`Mario-Rossi-seduta-3.ics`). Il
titolo importato nel calendario mostra nome, servizio e, se applicabile,
`Seduta 3 di 10`. Per gli appuntamenti di coppia ogni persona riceve il proprio
nome nel file e nel titolo. La modifica vale per le nuove conferme inviate;
gli eventi già importati non vengono rinominati automaticamente.

I messaggi distinguono rete irraggiungibile, timeout, autenticazione, permessi,
dominio non verificato, restrizioni di prova e limiti del provider. Nei log email
si registrano solo provider e codice controllato: nessuna risposta grezza del
provider, password, chiave API o indirizzo del destinatario.

Un invio riuscito indica l'accettazione da parte del servizio email, non la
consegna garantita nella casella del destinatario.

## Stato persistente e reinvio individuale

La conferma con allegato ICS è attiva automaticamente durante **Crea appuntamento**
quando almeno uno dei clienti selezionati ha un'email. Per le coppie vengono
contattate entrambe le persone se entrambe hanno un indirizzo, altrimenti solo
quella con email. L'invio avviene dopo il salvataggio dell'appuntamento, non al
momento della selezione del cliente.

È possibile togliere la spunta per non inviare la conferma per quell'appuntamento:
la scelta resta valida durante la compilazione e gli eventuali tentativi dopo un
errore. Una nuova apertura del modulo ripristina il comportamento automatico.
Gli slot **Occupato** non inviano conferme. Il server mantiene il medesimo default
quando il campo `invia_conferma_email` è assente; un valore esplicito `false`
disattiva l'invio. Le protezioni contro i reinvii incerti rimangono invariate.

Durante **Crea appuntamento**, se una persona selezionata non ha un'email,
compare un campo sotto la spunta di conferma. Per una coppia i campi sono distinti
e riportano il nome della persona. Compilandoli e premendo **Salva appuntamento**,
gli indirizzi validi vengono salvati nelle rispettive anagrafiche prima di creare
l'appuntamento e inviare le eventuali conferme con ICS.

I campi sono facoltativi: un campo vuoto non modifica l'anagrafica. Inserire un
indirizzo valido attiva automaticamente la conferma, salvo disattivazione manuale.
È possibile salvare l'indirizzo e togliere la spunta, nel qual caso non parte alcuna
conferma. Chiudere il box o annullare l'avviso di sovrapposizione non salva le email.
Le email già presenti non vengono sovrascritte da questa aggiunta rapida, nemmeno
se un altro operatore le inserisce durante il salvataggio.

L'aggiornamento delle anagrafiche e la creazione dell'appuntamento non sono una
singola transazione: in caso di errore, gli indirizzi già salvati restano in
anagrafica. Il box conserva quelli ancora da salvare per il nuovo tentativo.
Nessuna conferma viene avviata se prima fallisce il salvataggio di un indirizzo
compilato. Le protezioni RLS e il provider email non cambiano.

Nel box **Modifica appuntamento**, la sezione **Conferme email** mostra l'ultimo
esito per ciascuna persona, anche per gli appuntamenti di coppia. Si può inviare
la conferma a un solo destinatario senza ricreare l'appuntamento. L'allegato ICS
viene mantenuto. Gli invii già riusciti con gli stessi dati sono esclusi dal
reinvio; se cambia l'orario o l'indirizzo email si può inviare la nuova conferma.

Lo stato viene salvato nel campo JSONB `appuntamenti.email_conferme` tramite
aggiornamenti condizionali atomici, per evitare due invii simultanei allo stesso
destinatario. Non vengono salvati password, testo dell'email o indirizzi: solo
stato, orario, provider, codice controllato e impronta dei dati dell'invio.
Il campo contiene l'ultimo esito, non un registro completo di tutti i tentativi.

Un timeout o una disconnessione durante l'invio può avere esito incerto: il
gestionale non ritenta automaticamente e richiede una conferma esplicita prima
di riprovare, perché l'email potrebbe essere già stata accettata. Un invio rimasto
in corso per oltre due minuti viene trattato come incerto. Se il salvataggio dello
stato non è disponibile, non si avvia un nuovo invio.

Il campo va creato **prima di pubblicare il nuovo codice**: usare lo script
idempotente `sql/email_confirmation_tracking.sql` sugli altri ambienti. È già
stato applicato e verificato sul progetto Supabase collegato a questo gestionale.
Non modifica pacchetti, clienti o appuntamenti esistenti; per le vecchie conferme
compare “Nessun invio registrato”, senza supporre che siano state consegnate.

La scelta del provider resta invariata: queste funzioni non aggirano il blocco
SMTP di Render Free e non configurano un dominio o un servizio email.

Riferimenti: [limiti Render Free](https://render.com/docs/free),
[dominio di prova Resend](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain),
[errori API Resend](https://resend.com/docs/api-reference/errors).
