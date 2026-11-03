# Dipendenze del gestionale

## Ambiente online

Il deploy Live `13f9cf8` del 2 novembre 2026 usa **Python 3.14.3** e 50 pacchetti.
La versione è stata letta nel log di compilazione Render, insieme alla riga
`Successfully installed`. Questa è la baseline, senza aggiornamenti o downgrade.

- `.python-version` fissa Python a `3.14.3` per Render.
- `requirements.in` elenca le nove dipendenze dirette e le versioni online.
- `requirements.txt` blocca tutte le 50 dipendenze, dirette e indirette, con
  checksum SHA-256 dei pacchetti. È il file da installare su Render.

Il Build Command già usato da Render può restare:

```sh
pip install -r requirements.txt
```

La presenza degli hash attiva automaticamente il controllo di integrità di pip.
Per richiederlo esplicitamente in un nuovo ambiente:

```sh
python -m pip install --require-hashes -r requirements.txt
python -m pip check
```

Una variabile Render `PYTHON_VERSION`, se presente, ha precedenza sul file:
mantenerla coerente con `3.14.3`. Il nuovo file rende esplicita la versione già
usata, non introduce un cambio di runtime in produzione.

## Mac e ambiente isolato

Il Python di sistema del Mac è 3.9.6. Il gestionale locale e l'agente dei backup
non sono stati modificati e continuano a usare le loro librerie già installate.
La baseline locale è conservata separatamente in `requirements-local.in` e
`requirements-local.txt` (68 pacchetti, incluso Sentry 2.73.0).

Per ricreare il vecchio ambiente Mac:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-local.txt
.venv/bin/python -m pip check
.venv/bin/python -m pytest -q --disable-warnings
```

Per lavorare con le stesse versioni di Render, creare invece un ambiente con un
interprete Python **3.14.3** e installare `requirements.txt` con `--require-hashes`.
Non installare il file di produzione nel Python 3.9 del Mac: alcune librerie
online richiedono Python più recente. La migrazione dell'ambiente locale può
essere effettuata separatamente, senza cambiare il Python di sistema.

Le cartelle `.venv/` e `.venv-tools/` sono escluse da Git. Gli ambienti usati per
le verifiche di questo intervento si trovano sotto `/tmp/gestionale-dependency-check`,
non sono ambienti permanenti da cui avviare il gestionale o i backup.

## Aggiornamenti successivi

1. Modificare una versione in `requirements.in`.
2. Generare il file completo con uv, usando il target Linux/Python di Render:

   ```sh
   python3 -m venv .venv-tools
   .venv-tools/bin/python -m pip install uv==0.13.7
   .venv-tools/bin/uv pip compile requirements.in --python-version 3.14.3 --python-platform x86_64-unknown-linux-gnu --generate-hashes --no-annotate -o requirements.txt
   ```

3. Controllare il diff: senza `--upgrade` uv preferisce le versioni già compatibili
   del file esistente. Non aggiornare l'intero insieme per una singola modifica.
4. Installare in un ambiente pulito, eseguire `pip check`, i test e verificare
   disponibilità dei wheel Linux. Per aggiornare Python, verificare nuovamente
   anche le dipendenze e cambiare `.python-version` nello stesso intervento.
5. Versionare entrambi i file e `.python-version`. Non rigenerare la baseline
   online tramite `pip freeze` del Mac: ambiente e runtime sono diversi.

Il profilo `requirements-local.txt` è destinato al vecchio ambiente del Mac;
non viene usato dal Build Command Render. Va mantenuto separato finché il Mac
non sarà allineato a Python 3.14.3.

## Verifiche

La baseline locale è stata installata da zero e ha superato `pip check`, 244 test,
import dell'integrazione Flask/Sentry, login di test e generazione PDF.
La baseline online è stata installata da zero con Python 3.14.3 temporaneo e
`--require-hashes`: `pip check` senza conflitti, 244 test superati, import
Flask/Sentry, login e generazione PDF riusciti. Sono stati scaricati e verificati
anche tutti i 50 wheel Linux x86_64 per Python 3.14.3 con i checksum del file.
Durante i test applicativi sono usate credenziali di prova, Supabase simulato,
trasporti email bloccati e Sentry disabilitato. La prova applicativa locale usa
macOS: dopo il deploy va verificato l'accesso al gestionale su Render.

Non sono stati installati pacchetti nel Python globale o nel runtime dell'agente
backup, non sono stati toccati dati del gestionale né inviati promemoria.

Riferimenti ufficiali:

- [Installazioni ripetibili con pip](https://pip.pypa.io/en/stable/topics/repeatable-installs/).
- [Lock dei requirements con uv](https://docs.astral.sh/uv/pip/compile/).
- [Versione Python su Render](https://render.com/docs/python-version).
