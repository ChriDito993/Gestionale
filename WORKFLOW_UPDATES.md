# Aggiornamenti interfaccia e flussi

## Pagamenti temporaneamente nascosti

`SHOW_PAYMENTS` è disattivata per impostazione predefinita. Il collegamento nella
dashboard e il riepilogo nella scheda cliente non vengono mostrati. La pagina
`/pagamenti`, le API, il codice e i dati sono conservati: non è un blocco di accesso.
Per ripristinare i collegamenti, impostare `SHOW_PAYMENTS=true` nell'ambiente e
riavviare il servizio.

## Appuntamenti e promemoria

- Il box di modifica usa campi data e orario raggruppati e pulsanti coerenti.
- Le conferme email mostrano l'esito individuale e permettono il reinvio
  controllato. Configurazione e migrazione: `EMAIL_CONFIGURATION.md`.
- WhatsApp presenta un collegamento per ogni persona dell'appuntamento; il
  messaggio contiene il numero della seduta, anche per entrambe le persone della
  coppia. Occorre completare l'invio in WhatsApp: aprire il collegamento non è
  una prova di consegna.
- Prima di creare, spostare o ridimensionare un appuntamento, vengono controllate
  le sovrapposizioni con gli altri appuntamenti e gli slot “Occupato”. Un avviso
  permette di annullare oppure procedere. Sono inclusi gli appuntamenti ripetuti
  e le date personalizzate; due appuntamenti consecutivi non sono in conflitto.
  È un controllo informativo, non un blocco transazionale: due salvataggi
  contemporanei di operatori diversi possono comunque sovrapporsi.
- Le funzioni di promemoria Email/SMS non configurate non mostrano un falso esito
  positivo. Le conferme email si gestiscono dalla sezione dedicata.

## Clienti e pacchetti

L'archivio mantiene le viste schede/lista, aggiunge un contatore dei risultati e
la ricerca per nome completo anche con accenti. I pacchetti con due o meno sedute
rimanenti sono evidenziati in ambra nella selezione, nel riepilogo e nella scheda
cliente. La chiusura di un pacchetto richiede conferma prima di inviare il modulo;
il calcolo delle sedute e la logica di chiusura non sono stati cambiati.

## Verifiche ripetibili

```sh
python3 -m pytest -q --disable-warnings
node --test tests/test_workflow_frontend.js
node --check static/main.js
git diff --check
```

I test usano dati e invii simulati: non creano prenotazioni reali e non inviano
email o messaggi. La verifica grafica finale su browser resta da effettuare.
