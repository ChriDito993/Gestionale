# Conteggio automatico delle sedute

## Regole

- Una prenotazione collegata a un pacchetto consuma una seduta subito, come prima.
  Le sedute prenotate, confermate, completate/svolte e `no_show` contano;
  `annullato` e gli slot `occupato` non contano.
- Eliminazione o annullamento restituiscono la disponibilità, ricalcolando il
  numero reale di appuntamenti anziché decrementare un contatore alla cieca.
  Ripetere una cancellazione non restituisce due sedute.
- Le sedute valide del pacchetto vengono numerate in ordine di data, orario e ID,
  senza buchi né duplicati, anche dopo spostamenti o inserimenti fuori ordine.
- Un pacchetto esaurito torna attivo se si libera una seduta. Un pacchetto chiuso
  volontariamente resta chiuso; una scadenza trascorsa impedisce nuovi utilizzi.
- Non vengono mai prenotate più sedute della capienza di un singolo pacchetto.
  Se un pacchetto è selezionato esplicitamente e la serie non ci sta, viene
  rifiutata tutta la serie, senza appuntamenti o collegamenti creati a metà.
- Nell'abbinamento automatico viene cercato prima il servizio corretto e poi
  il pacchetto disponibile, con precedenza ai più vecchi. Se necessario si usano
  pacchetti successivi. Le prenotazioni senza copertura restano singole e il
  gestionale mostra un avviso: non compaiono sedute 11/10 o saldi negativi.
- Per una coppia la prenotazione conta una sola volta, anche con due partecipanti.
  Un pacchetto esplicitamente selezionato può appartenere a uno dei partecipanti.

## Appuntamenti prima e dopo l'assegnazione

Come concordato, assegnando un pacchetto vengono collegati automaticamente solo
gli appuntamenti **futuri, dello stesso servizio e non collegati a un altro
pacchetto**, fino alla capienza disponibile. Non si riassegnano sedute già coperte
e non si collegano retroattivamente appuntamenti passati.

La stessa riconciliazione viene eseguita dopo creazione, modifica, annullamento,
ripristino e cancellazione: un posto liberato può coprire una futura prenotazione
compatibile già presente. Ripristinare un appuntamento annullato non supera la
capienza: se il posto è stato riutilizzato, si cerca altra copertura disponibile
oppure l'appuntamento ripristinato rimane senza pacchetto.

Cambiare servizio rimuove un collegamento incompatibile, restituisce la seduta
al vecchio pacchetto e cerca la copertura corretta. Anche la cancellazione del
cliente primario di una coppia riallinea il pacchetto dell'eventuale altro titolare.

## Transazioni e sicurezza

Il backend usa `public.gestionale_package_operation(text,jsonb)` per creazione
di serie, modifica, eliminazione, assegnazione, chiusura e cancellazione cliente.
Ogni operazione è una transazione e acquisisce lo stesso advisory lock prima di
leggere o scrivere il conteggio. Non sono previste chiamate email o HTTP mentre
il lock è detenuto; le conferme partono solo dopo il salvataggio riuscito.

La funzione e gli helper in `gestionale_internal` sono `SECURITY INVOKER`, con
`search_path` fissato, e accessibili soltanto al backend `service_role`.
Nessuna policy pubblica o privilegio sulle tabelle è stato riaperto. Non modificare
direttamente contatori/collegamenti con SQL o script esterni: questi devono usare
lo stesso percorso transazionale per conservarne le garanzie.

Le vecchie cache di lettura locali al processo non vengono più usate per i
conteggi e il calendario: sarebbero incoerenti tra worker diversi. Il calendario
ricarica anche le altre sedute dopo uno spostamento; il contatore dei pacchetti
si aggiorna al caricamento degli eventi.

## Installazione e dati esistenti

La migrazione `transactional_package_accounting` è già applicata al progetto
collegato. Il file ripetibile per altri ambienti è `sql/package_accounting.sql`.
Occorre pubblicare il codice Python/JavaScript aggiornato per attivare il nuovo
percorso nelle operazioni del gestionale. Non serve cambiare `.env`.

Prima della migrazione è stato creato e verificato il backup logico privato
`.backups/pre-package-accounting-20261023-mvl09ti0/`, escluso da Git. Contiene dati
personali in chiaro con permessi locali restrittivi: non condividerlo o pubblicarlo.

L'installazione ha riallineato i collegamenti già esistenti, correggendo cinque
numeri fuori sequenza, senza collegare in massa prenotazioni scoperte e senza
inviare nuove email. I conteggi reali risultavano già corrispondenti alle righe.

Il nuovo campo `chiusura_manuale` distingue chiusura volontaria ed esaurimento.
Per il vecchio storico, che non conservava questa distinzione, i 18 pacchetti
chiusi sotto capienza sono stati conservati come chiusi manualmente; i 7 chiusi
a capienza sono considerati esauriti. Non è possibile ricostruire con certezza
un'eventuale chiusura volontaria fatta in passato quando il pacchetto era già pieno.
Da questa versione il pulsante di chiusura registra sempre la distinzione.

## Email e ICS

La rinumerazione non invia automaticamente nuove conferme e non modifica eventi
già importati nei calendari personali. L'impronta dei dati nell'esito email rende
riconoscibili le conferme divenute obsolete; si possono reinviare con conferma
esplicita dalla sezione dedicata. Le nuove conferme usano il numero ricalcolato.

## Verifiche

```sh
python3 -m pytest -q --disable-warnings
node --test tests/test_workflow_frontend.js
python3 scripts/package_accounting_test_sql.py
```

L'ultimo comando genera SQL di test, da eseguire con un collegamento PostgreSQL
autorizzato o tramite MCP. Usa solo tabelle/funzioni `pg_temp`, un lock separato e
`ROLLBACK`: nessun appuntamento reale, nessuna modifica persistente o email.
Sono verificati cancellazione 10→9, rinumerazione, annullamento ripetuto,
ripristino, capienza, serie atomiche, cambio servizio, chiusura manuale,
assegnazione dopo prenotazione, coppie, slot occupati e pacchetti consecutivi.

Le verifiche SQL sul progetto confermano zero divergenze nei contatori e nella
numerazione, RLS attiva su sette tabelle e funzione non eseguibile da `anon` o
`authenticated`. Gli avvisi preesistenti del Security Advisor restano quelli
documentati in `SUPABASE_SECURITY.md`; nessun nuovo errore di sicurezza introdotto.
