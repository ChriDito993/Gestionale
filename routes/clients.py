"""Customer HTTP views, registered explicitly to preserve their Flask endpoint names."""
import re
from datetime import date, datetime
from io import BytesIO

from flask import jsonify, redirect, render_template, request, send_file
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.pagesizes import A4

from package_accounting import package_operation


class ClientViews:
    def __init__(self, get_database, studio_now, logger,
                 invalidate_calendar_cache, invalidate_dashboard_caches):
        self.get_database = get_database
        self.studio_now = studio_now
        self.logger = logger
        self.invalidate_calendar_cache = invalidate_calendar_cache
        self.invalidate_dashboard_caches = invalidate_dashboard_caches

    @property
    def database(self):
        # Resolve the active client at request time, including isolated test databases.
        return self.get_database()

    def get_clienti(self):
        response = self.database.table("clienti") \
            .select("id,nome,cognome,telefono,email") \
            .execute()
        return jsonify(response.data)


    def crea_cliente(self):
        data = request.json or {}

        telefono = data.get("telefono")

        # Normalizzazione telefono (aggiunge 39 se numero italiano senza prefisso)
        if telefono:
            telefono = telefono.replace(" ", "").replace("-", "").replace("+", "")
            if telefono.startswith("3") and len(telefono) == 10:
                telefono = "39" + telefono
            data["telefono"] = telefono

        response = self.database.table("clienti").insert(data).execute()
        return jsonify(response.data)


    def validate_client_birth_date(self, value):
        """Optional profile date, never a timestamp or a date in the future."""
        if value is None or value == "":
            return None
        if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value.strip()):
            raise ValueError("Inserisci una data di nascita valida")
        try:
            born = date.fromisoformat(value.strip())
        except ValueError:
            raise ValueError("Inserisci una data di nascita valida") from None
        if born > self.studio_now().date():
            raise ValueError("La data di nascita non può essere futura")
        return born.isoformat()


    def aggiorna_cliente(self, cliente_id):
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"error": "Dati anagrafici non validi"}), 400

        if "data_nascita" in data:
            try:
                data["data_nascita"] = self.validate_client_birth_date(data["data_nascita"])
            except ValueError as error:
                return jsonify({"error": str(error)}), 400

        telefono = data.get("telefono")

        # Normalizzazione telefono
        if telefono:
            telefono = telefono.replace(" ", "").replace("-", "").replace("+", "")
            if telefono.startswith("3") and len(telefono) == 10:
                telefono = "39" + telefono

        # Permettiamo solo campi modificabili
        campi_aggiornabili = {
            "nome": data.get("nome"),
            "cognome": data.get("cognome"),
            "telefono": telefono,
            "email": data.get("email")
        }

        # Rimuoviamo eventuali None
        campi_aggiornabili = {k: v for k, v in campi_aggiornabili.items() if v is not None}
        # Omitted dates stay unchanged; an explicit empty date clears only this field.
        if "data_nascita" in data:
            campi_aggiornabili["data_nascita"] = data["data_nascita"]

        response = self.database.table("clienti") \
            .update(campi_aggiornabili) \
            .eq("id", cliente_id) \
            .execute()

        return jsonify(response.data)


    def aggiungi_email_cliente(self, cliente_id):
        data = request.get_json(silent=True)
        email = data.get("email") if isinstance(data, dict) else None
        if not isinstance(email, str):
            return jsonify({"error": "Inserisci un indirizzo email valido"}), 400
        email = email.strip()
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            return jsonify({"error": "Inserisci un indirizzo email valido"}), 400

        rows = self.database.table("clienti").select("id,email").eq("id", cliente_id).limit(1).execute().data or []
        if not rows:
            return jsonify({"error": "Cliente non trovato"}), 404
        precedente = rows[0].get("email")
        if precedente and precedente.strip():
            if precedente.strip().casefold() == email.casefold():
                return jsonify({"id": rows[0]["id"], "email": precedente.strip()})
            return jsonify({"error": "Il cliente ha già un'email in anagrafica. Ricarica i clienti prima di riprovare."}), 409

        query = self.database.table("clienti").update({"email": email}).eq("id", cliente_id)
        # Compare-and-swap: un altro operatore potrebbe averla aggiunta nel frattempo.
        query = query.is_("email", "null") if precedente is None else query.eq("email", precedente)
        aggiornati = query.execute().data or []
        if not aggiornati:
            return jsonify({"error": "L'anagrafica è cambiata. Ricarica i clienti prima di riprovare."}), 409
        return jsonify({"id": aggiornati[0]["id"], "email": aggiornati[0]["email"]})


    def elimina_cliente(self, cliente_id):
        result = package_operation(self.database, "delete_client", {"id": cliente_id})
        if not result.get("deleted"):
            return jsonify({"error": "Cliente non trovato"}), 404
        self.invalidate_calendar_cache()
        self.invalidate_dashboard_caches()
        return jsonify({"success": True})


    def get_cliente_singolo(self, cliente_id):
        response = self.database.table("clienti") \
            .select("id, nome, cognome, telefono, email") \
            .eq("id", cliente_id) \
            .single() \
            .execute()

        if not response.data:
            return jsonify({"error": "Cliente non trovato"}), 404

        return jsonify(response.data)


    def compleanni_oggi(self):
        today = self.studio_now().date()
        birthdays = []
        page_size = 1000
        offset = 0
        try:
            while True:
                rows = self.database.table("clienti").select("id,nome,cognome,data_nascita") \
                    .order("id").range(offset, offset + page_size - 1).execute().data
                if not isinstance(rows, list):
                    raise ValueError("Missing birthdays response")
                for client in rows:
                    try:
                        # Postgres DATE values are ISO dates, independent of the birth year.
                        born = date.fromisoformat(client.get("data_nascita") or "")
                    except (TypeError, ValueError):
                        continue
                    if born <= today and (born.month, born.day) == (today.month, today.day):
                        birthdays.append({key: client.get(key) for key in ("id", "nome", "cognome")})
                if len(rows) < page_size:
                    break
                offset += page_size
            birthdays.sort(key=lambda person: (str(person.get("cognome") or "").casefold(), str(person.get("nome") or "").casefold(), str(person["id"])))
            result = jsonify({"data": today.isoformat(), "clienti": birthdays})
        except Exception:
            self.logger.exception("Errore lettura compleanni del giorno")
            result = jsonify({"error": "Impossibile caricare i compleanni. Riprova tra poco."})
            result.status_code = 503
        result.headers["Cache-Control"] = "no-store"
        return result


    def lista_clienti(self):
        response = self.database.table("clienti") \
            .select("id,nome,cognome,telefono,email") \
            .order("cognome") \
            .execute()

        return render_template("clienti.html", clienti=response.data)


    def dettaglio_cliente(self, cliente_id):

        cliente = self.database.table("clienti") \
            .select("*") \
            .eq("id", cliente_id) \
            .single() \
            .execute().data

        tipi_pacchetto = self.database.table("tipi_pacchetto") \
            .select("*, servizi(nome)") \
            .execute().data

        pacchetti_cliente = self.database.table("pacchetti_cliente") \
            .select("*, tipi_pacchetto(nome, numero_sedute)") \
            .eq("cliente_id", cliente_id) \
            .eq("stato", "attivo") \
            .execute().data
    
        for pac in pacchetti_cliente:
            pac["sedute_rimanenti"] = max(0,
                pac["tipi_pacchetto"]["numero_sedute"] - (pac["sedute_effettuate"] or 0))

        now = datetime.now().isoformat()

        # Recupero appuntamenti tramite tabella ponte
        relazioni = self.database.table("appuntamenti_clienti") \
            .select("appuntamento_id") \
            .eq("cliente_id", cliente_id) \
            .execute().data

        appuntamenti_ids = [r["appuntamento_id"] for r in relazioni]

        # Evita errore se lista vuota
        if not appuntamenti_ids:
            appuntamenti_ids = ["00000000-0000-0000-0000-000000000000"]

        appuntamenti_raw = self.database.table("appuntamenti") \
            .select("*, servizi(nome), appuntamenti_clienti(cliente_id, clienti(nome,cognome))") \
            .in_("id", appuntamenti_ids) \
            .gte("start_datetime", now) \
            .order("start_datetime") \
            .execute().data

        appuntamenti = []

        for appo in appuntamenti_raw:
            dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
            data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")

            condivisi = []

            for rel in appo.get("appuntamenti_clienti", []):
                cid = rel.get("cliente_id")
                cliente_rel = rel.get("clienti")

                if cid and str(cid) != str(cliente_id) and cliente_rel:
                    condivisi.append(f"👤 {cliente_rel['nome']} {cliente_rel['cognome']}")

            appuntamenti.append({
                "id": appo["id"],
                "data_formattata": data_formattata,
                "servizio": appo["servizi"]["nome"],
                "stato": appo["stato"],
                "condivisi": condivisi
            })

        # ===============================
        # STORICO COMPLETO APPUNTAMENTI
        # ===============================

        storico_raw = self.database.table("appuntamenti") \
            .select("*, servizi(nome), appuntamenti_clienti(cliente_id, clienti(nome,cognome))") \
            .in_("id", appuntamenti_ids) \
            .order("start_datetime", desc=True) \
            .execute().data

        storico_appuntamenti = []

        totale_sedute = 0
        ultima_visita = None
        prossima_visita = None

        now_dt = datetime.now()

        for appo in storico_raw:
            dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
            data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")

            condivisi = []
            for rel in appo.get("appuntamenti_clienti", []):
                cid = rel.get("cliente_id")
                cliente_rel = rel.get("clienti")
                if cid and str(cid) != str(cliente_id) and cliente_rel:
                    condivisi.append(f"👤 {cliente_rel['nome']} {cliente_rel['cognome']}")

            storico_appuntamenti.append({
                "id": appo["id"],
                "data_formattata": data_formattata,
                "servizio": appo["servizi"]["nome"],
                "stato": appo.get("stato"),
                "numero_seduta": appo.get("numero_seduta"),
                "note": (appo.get("note") or "").strip(),
                "condivisi": condivisi
            })

            # Calcolo totale sedute (basato su numero_seduta)
            if appo.get("numero_seduta"):
                totale_sedute += 1

            # Ultima visita (passata più recente)
            if dt <= now_dt:
                if not ultima_visita or dt > ultima_visita:
                    ultima_visita = dt

            # Prossima visita (futura più vicina)
            if dt > now_dt:
                if not prossima_visita or dt < prossima_visita:
                    prossima_visita = dt

        ultima_visita_str = ultima_visita.strftime("%d/%m/%Y") if ultima_visita else None
        prossima_visita_str = prossima_visita.strftime("%d/%m/%Y") if prossima_visita else None

        # Sedute rimanenti (somma pacchetti attivi)
        sedute_rimanenti = sum(pac.get("sedute_rimanenti", 0) for pac in pacchetti_cliente)

        nome_cliente_pagamenti = f"{cliente.get('nome', '')} {cliente.get('cognome', '')}".strip()

        pagamenti_raw = self.database.table("pagamenti") \
            .select("cliente,importo,data_pagamento,note") \
            .eq("cliente", nome_cliente_pagamenti) \
            .order("data_pagamento", desc=True) \
            .execute().data or []

        def parse_importo_pagamento(value):
            if isinstance(value, (int, float)):
                return float(value)

            raw = str(value or "").strip().replace("€", "").replace(" ", "")
            if raw.count(",") == 1 and raw.count(".") >= 1:
                raw = raw.replace(".", "").replace(",", ".")
            elif "," in raw:
                raw = raw.replace(",", ".")

            try:
                return float(raw)
            except (TypeError, ValueError):
                return 0.0

        pagamenti_cliente = []
        totale_pagamenti = 0.0

        for pagamento in pagamenti_raw:
            importo_value = parse_importo_pagamento(pagamento.get("importo"))
            totale_pagamenti += importo_value

            data_value = pagamento.get("data_pagamento")
            try:
                data_dt = datetime.fromisoformat(str(data_value).replace("Z", "+00:00"))
                data_formattata = data_dt.strftime("%d/%m/%Y")
            except (TypeError, ValueError):
                data_formattata = data_value or "-"

            importo_label = f"€ {importo_value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

            pagamenti_cliente.append({
                "cliente": pagamento.get("cliente") or "-",
                "data_formattata": data_formattata,
                "importo": importo_value,
                "importo_label": importo_label,
                "note": pagamento.get("note") or "-"
            })

        totale_pagamenti_label = f"€ {totale_pagamenti:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        ultimo_pagamento_data = pagamenti_cliente[0]["data_formattata"] if pagamenti_cliente else None

        return render_template(
            "cliente_dettaglio.html",
            cliente=cliente,
            data_oggi_studio=self.studio_now().date().isoformat(),
            appuntamenti=appuntamenti,
            tipi_pacchetto=tipi_pacchetto,
            pacchetti_cliente=pacchetti_cliente,
            storico_appuntamenti=storico_appuntamenti,
            stats_totali=totale_sedute,
            stats_rimanenti=sedute_rimanenti,
            ultima_visita=ultima_visita_str,
            prossima_visita=prossima_visita_str,
            pagamenti_cliente=pagamenti_cliente,
            pagamenti_totale_label=totale_pagamenti_label,
            pagamenti_count=len(pagamenti_cliente),
            pagamenti_ultimo=ultimo_pagamento_data
        )


    def aggiorna_note(self, cliente_id):

        note = request.form.get("note_cliniche")

        self.database.table("clienti") \
            .update({"note_cliniche": note}) \
            .eq("id", cliente_id) \
            .execute()

        return redirect(f"/cliente/{cliente_id}")


    def genera_promemoria(self, cliente_id):

        cliente = self.database.table("clienti") \
            .select("*") \
            .eq("id", cliente_id) \
            .single() \
            .execute().data

        now = datetime.now().isoformat()

        # Include appuntamenti condivisi (tabella ponte) + fallback legacy (cliente_id diretto)
        relazioni = self.database.table("appuntamenti_clienti") \
            .select("appuntamento_id") \
            .eq("cliente_id", cliente_id) \
            .execute().data or []

        appuntamenti_ids = {
            rel.get("appuntamento_id")
            for rel in relazioni
            if rel.get("appuntamento_id")
        }

        legacy_rows = self.database.table("appuntamenti") \
            .select("id") \
            .eq("cliente_id", cliente_id) \
            .gte("start_datetime", now) \
            .execute().data or []

        for row in legacy_rows:
            app_id = row.get("id")
            if app_id:
                appuntamenti_ids.add(app_id)

        appuntamenti_raw = []
        if appuntamenti_ids:
            appuntamenti_raw = self.database.table("appuntamenti") \
                .select("*, servizi(nome)") \
                .in_("id", list(appuntamenti_ids)) \
                .gte("start_datetime", now) \
                .order("start_datetime") \
                .execute().data or []

        appuntamenti_raw.sort(key=lambda appo: appo.get("start_datetime", ""))

        buffer = BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=A4)
        elements = []
        styles = getSampleStyleSheet()

        elements.append(Paragraph(
            "<b>MASSOTERAPIA & PT di Christian Di Tommaso</b>",
            styles["Heading1"]
        ))
        elements.append(Spacer(1, 0.3 * inch))

        elements.append(Paragraph("Promemoria Appuntamenti", styles["Heading2"]))
        elements.append(Spacer(1, 0.3 * inch))

        elements.append(Paragraph(
            f"<b>Cliente:</b> {cliente['nome']} {cliente['cognome']}",
            styles["Normal"]
        ))
        elements.append(Spacer(1, 0.3 * inch))

        lista = []

        for appo in appuntamenti_raw:
            dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
            data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")
            testo = f"{data_formattata} - {appo['servizi']['nome']}"
            lista.append(ListItem(Paragraph(testo, styles["Normal"])))

        if not lista:
            elements.append(Paragraph("Nessun appuntamento futuro registrato.", styles["Normal"]))
        else:
            elements.append(ListFlowable(lista, bulletType="bullet"))
        elements.append(Spacer(1, 0.5 * inch))

        oggi = datetime.now().strftime("%d/%m/%Y")
        elements.append(Paragraph(f"Documento generato il {oggi}", styles["Italic"]))

        doc.build(elements)
        buffer.seek(0)

        return send_file(
            buffer,
            as_attachment=False,
            download_name="promemoria_appuntamenti.pdf",
            mimetype="application/pdf"
        )



def register_client_routes(app, login_required, *, get_database, studio_now,
                           invalidate_calendar_cache, invalidate_dashboard_caches):
    views = ClientViews(get_database, studio_now, app.logger,
                        invalidate_calendar_cache, invalidate_dashboard_caches)
    rules = [
        ('/api/clienti', 'get_clienti', ['GET']),
        ('/api/clienti', 'crea_cliente', ['POST']),
        ('/api/clienti/<cliente_id>', 'aggiorna_cliente', ['PUT']),
        ('/api/clienti/<cliente_id>/email', 'aggiungi_email_cliente', ['PUT']),
        ('/api/clienti/<cliente_id>', 'elimina_cliente', ['DELETE']),
        ('/api/clienti/<cliente_id>', 'get_cliente_singolo', ['GET']),
        ('/api/compleanni_oggi', 'compleanni_oggi', ['GET']),
        ('/clienti', 'lista_clienti', ['GET']),
        ('/cliente/<cliente_id>', 'dettaglio_cliente', ['GET']),
        ('/cliente/<cliente_id>/note', 'aggiorna_note', ['POST']),
        ('/cliente/<cliente_id>/promemoria', 'genera_promemoria', ['GET']),
    ]
    for rule, endpoint, methods in rules:
        app.add_url_rule(rule, endpoint=endpoint,
                         view_func=login_required(getattr(views, endpoint)), methods=methods)
