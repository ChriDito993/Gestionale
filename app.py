import os
from flask import Flask, render_template, request, jsonify, redirect, send_file, session, render_template_string
from supabase import create_client
from dotenv import load_dotenv
from datetime import datetime
from functools import wraps

from io import BytesIO


import requests

from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, ListFlowable, ListItem
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.lib.pagesizes import A4

# ===============================
# CONFIG BASE
# ===============================

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static")
)

app.secret_key = os.getenv("SECRET_KEY", "super-secret-key-change-me")

ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

# ===============================
# LOGIN REQUIRED DECORATOR
# ===============================

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect("/login")
        return f(*args, **kwargs)
    return decorated_function

# ===============================
# HOME
# ===============================

@app.route("/")
@login_required
def index():
    return render_template("index.html")

# ===============================
# API CLIENTI
# ===============================

# ===============================
# LOGIN
# ===============================

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email")
        password = request.form.get("password")

        if email == ADMIN_EMAIL and password == ADMIN_PASSWORD:
            session["logged_in"] = True
            return redirect("/")
        else:
            error = "Credenziali non valide"
    else:
        error = None

    # Login page styled like gestionale (Apple minimal)
    return render_template_string("""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset=\"UTF-8\">
        <title>Login - Gestionale</title>
        <link rel=\"stylesheet\" href=\"{{ url_for('static', filename='style.css') }}\">
    </head>
    <body style=\"display:flex;justify-content:center;align-items:center;height:100vh;background:linear-gradient(135deg,#f3f4f6,#e5e7eb);\">
        <div class=\"detail-card\" style=\"width:380px;\">
            <h3 style=\"margin-bottom:25px;\">Accesso Gestionale</h3>
            <form method=\"POST\" style=\"display:flex;flex-direction:column;gap:16px;\">
                <input type=\"email\" name=\"email\" placeholder=\"Email\" required class=\"input-apple\">
                <input type=\"password\" name=\"password\" placeholder=\"Password\" required class=\"input-apple\">
                <button type=\"submit\" class=\"btn-apple-primary\" style=\"width:100%;\">Accedi</button>
            </form>
            {% if error %}
                <p style=\"color:#ef4444;margin-top:18px;font-size:14px;\">{{ error }}</p>
            {% endif %}
        </div>
    </body>
    </html>
    """, error=error)

@app.route("/logout")
@login_required
def logout():
    session.clear()
    return redirect("/login")

@app.route("/api/clienti", methods=["GET"])
@login_required
def get_clienti():
    response = supabase.table("clienti").select("*").execute()
    return jsonify(response.data)


@app.route("/api/clienti", methods=["POST"])
@login_required
def crea_cliente():
    data = request.json
    response = supabase.table("clienti").insert(data).execute()
    return jsonify(response.data)

# PUT route per aggiornare dati anagrafici di un cliente
@app.route("/api/clienti/<cliente_id>", methods=["PUT"])
@login_required
def aggiorna_cliente(cliente_id):
    data = request.json

    # Permettiamo solo campi modificabili
    campi_aggiornabili = {
        "nome": data.get("nome"),
        "cognome": data.get("cognome"),
        "telefono": data.get("telefono"),
        "email": data.get("email")
    }

    # Rimuoviamo eventuali None
    campi_aggiornabili = {k: v for k, v in campi_aggiornabili.items() if v is not None}

    response = supabase.table("clienti") \
        .update(campi_aggiornabili) \
        .eq("id", cliente_id) \
        .execute()

    return jsonify(response.data)

# ===============================
# API APPUNTAMENTI
# ===============================

@app.route("/api/appuntamenti", methods=["GET"])
@login_required
def get_appuntamenti():

    start = request.args.get("start")
    end = request.args.get("end")

    # 🔧 Normalizzazione formato ISO (rimuove timezone se presente)
    if start:
        start = start.split("+")[0].split(" ")[0].replace("Z", "")
    if end:
        end = end.split("+")[0].split(" ")[0].replace("Z", "")

    query = supabase.table("appuntamenti") \
        .select("""
            *,
            servizi(nome,colore_calendario),
            appuntamenti_clienti(
                cliente_id,
                clienti(nome,cognome)
            )
        """)

    # 🔹 Filtro per intervallo visibile (se presente)
    if start and end:
        query = query.gte("start_datetime", start).lt("start_datetime", end)

    try:
        response = query.execute()
    except Exception as e:
        print("🔥 ERRORE QUERY SUPABASE:", e)
        return jsonify([])

    if not response or response.data is None:
        print("Errore Supabase response vuota:", response)
        return jsonify([])

    eventi = []

    for appo in response.data:

        clienti_nomi = []
        clienti_ids = []

        for relazione in appo.get("appuntamenti_clienti", []):
            cliente = relazione.get("clienti")
            cliente_id = relazione.get("cliente_id")

            if cliente:
                clienti_nomi.append(f"{cliente['nome']} {cliente['cognome']}")

            if cliente_id:
                clienti_ids.append(cliente_id)

        nomi_clienti = " + ".join(clienti_nomi)

        nome_servizio = appo["servizi"]["nome"]
        colore = appo["servizi"]["colore_calendario"]

        titolo = f"{nomi_clienti} - {nome_servizio}" if nomi_clienti else nome_servizio

        # 🔹 Aggiungi numero seduta se presente
        if appo.get("numero_seduta"):
            titolo += f" (S{appo['numero_seduta']})"

        eventi.append({
    "id": appo["id"],
    "title": titolo,
    "start": appo["start_datetime"],
    "end": appo["end_datetime"],
    "backgroundColor": colore,
    "extendedProps": {
        "stato": appo.get("stato"),
        "clienti": nomi_clienti,
        "clienti_ids": clienti_ids,
        "servizio": nome_servizio,
        "numero_seduta": appo.get("numero_seduta")
    }
})

    return jsonify(eventi)

@app.route("/api/appuntamenti", methods=["POST"])
@login_required
def crea_appuntamento():

    data = request.json

    clienti_ids = data.get("clienti_ids") or []
    cliente_id_singolo = data.get("cliente_id")

    # 🔹 Compatibilità con vecchio sistema
    if not clienti_ids and cliente_id_singolo:
        clienti_ids = [cliente_id_singolo]

    # 🔒 Controllo sicurezza
    if not clienti_ids:
        return jsonify({"error": "Nessun cliente selezionato"}), 400

    # 🔹 Se dal frontend viene passato un pacchetto specifico lo usiamo
    pacchetto_id = data.get("pacchetto_cliente_id")
    numero_seduta = None

    cliente_principale = clienti_ids[0]

    if pacchetto_id:
        # Recupero pacchetto selezionato
        pacchetto = supabase.table("pacchetti_cliente") \
            .select("*, tipi_pacchetto(servizio_id)") \
            .eq("id", pacchetto_id) \
            .single() \
            .execute()

        if pacchetto.data:
            pac = pacchetto.data

            # Controllo che il pacchetto appartenga al cliente
            if pac["cliente_id"] == cliente_principale:

                # Controllo che il servizio combaci
                if pac["tipi_pacchetto"]["servizio_id"] == data["servizio_id"]:
                    numero_seduta = pac["sedute_effettuate"] + 1
                else:
                    pacchetto_id = None
            else:
                pacchetto_id = None
    else:
        # 🔹 Comportamento automatico precedente (fallback)
        pacchetto_attivo = supabase.table("pacchetti_cliente") \
            .select("*, tipi_pacchetto(servizio_id)") \
            .eq("cliente_id", cliente_principale) \
            .eq("stato", "attivo") \
            .limit(1) \
            .execute()

        if pacchetto_attivo.data:
            pac = pacchetto_attivo.data[0]

            if pac["tipi_pacchetto"]["servizio_id"] == data["servizio_id"]:
                pacchetto_id = pac["id"]
                numero_seduta = pac["sedute_effettuate"] + 1

    nuovo_appuntamento = supabase.table("appuntamenti").insert({
        "cliente_id": cliente_principale,  # manteniamo per compatibilità
        "servizio_id": data["servizio_id"],
        "start_datetime": data["start_datetime"],
        "end_datetime": data["end_datetime"],
        "pacchetto_cliente_id": pacchetto_id,
        "numero_seduta": numero_seduta,
        "stato": "prenotato",
        "scalato": False
    }).execute()

    appuntamento_id = nuovo_appuntamento.data[0]["id"]

    # 🔹 Inserimento clienti nella tabella ponte
    for cliente_id in clienti_ids:
        try:
            supabase.table("appuntamenti_clienti").insert({
                "appuntamento_id": appuntamento_id,
                "cliente_id": cliente_id
            }).execute()
        except Exception as e:
            print("Errore inserimento cliente in appuntamenti_clienti:", e)

    # 🔹 Risposta finale API
    if nuovo_appuntamento.data:
        return jsonify({
            "success": True,
            "numero_seduta": numero_seduta
        })
    else:
        return jsonify({"error": "Errore creazione appuntamento"}), 500

@app.route("/api/appuntamenti/<id>", methods=["PUT"])
@login_required
def aggiorna_appuntamento(id):
    data = request.json
    response = supabase.table("appuntamenti") \
        .update(data) \
        .eq("id", id) \
        .execute()
    return jsonify(response.data)

@app.route("/api/appuntamenti/<id>", methods=["DELETE"])
@login_required
def elimina_appuntamento(id):
    supabase.table("appuntamenti") \
        .delete() \
        .eq("id", id) \
        .execute()
    return jsonify({"success": True})


# ===============================
# API per pacchetti attivi di un cliente
# ===============================

@app.route("/api/pacchetti_attivi/<cliente_id>", methods=["GET"])
@login_required
def get_pacchetti_attivi(cliente_id):

    pacchetti = supabase.table("pacchetti_cliente") \
        .select("*, tipi_pacchetto(nome, numero_sedute, servizio_id)") \
        .eq("cliente_id", cliente_id) \
        .eq("stato", "attivo") \
        .execute().data

    risultati = []

    for pac in pacchetti:
        numero_totale = pac["tipi_pacchetto"]["numero_sedute"]
        effettuate = pac["sedute_effettuate"]
        rimanenti = numero_totale - effettuate

        risultati.append({
            "id": pac["id"],
            "nome": pac["tipi_pacchetto"]["nome"],
            "servizio_id": pac["tipi_pacchetto"]["servizio_id"],
            "sedute_rimanenti": rimanenti
        })

    return jsonify(risultati)

# ===============================
# API SERVIZI
# ===============================

@app.route("/api/servizi", methods=["GET"])
@login_required
def get_servizi():
    response = supabase.table("servizi").select("*").execute()
    return jsonify(response.data)

# ===============================
# ARCHIVIO CLIENTI
# ===============================

@app.route("/clienti")
@login_required
def lista_clienti():
    response = supabase.table("clienti") \
        .select("*") \
        .order("cognome") \
        .execute()

    return render_template("clienti.html", clienti=response.data)

# ===============================
# DETTAGLIO CLIENTE
# ===============================

@app.route("/cliente/<cliente_id>")
@login_required
def dettaglio_cliente(cliente_id):

    cliente = supabase.table("clienti") \
        .select("*") \
        .eq("id", cliente_id) \
        .single() \
        .execute().data

    tipi_pacchetto = supabase.table("tipi_pacchetto") \
        .select("*, servizi(nome)") \
        .execute().data

    pacchetti_cliente = supabase.table("pacchetti_cliente") \
        .select("*, tipi_pacchetto(nome, numero_sedute)") \
        .eq("cliente_id", cliente_id) \
        .eq("stato", "attivo") \
        .execute().data
    
    for pac in pacchetti_cliente:
        pac["sedute_rimanenti"] = (
            pac["tipi_pacchetto"]["numero_sedute"] - pac["sedute_effettuate"]
    )

    now = datetime.now().isoformat()

    appuntamenti_raw = supabase.table("appuntamenti") \
        .select("*, servizi(nome)") \
        .eq("cliente_id", cliente_id) \
        .gte("start_datetime", now) \
        .order("start_datetime") \
        .execute().data

    appuntamenti = []

    for appo in appuntamenti_raw:
        dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
        data_formattata = dt.strftime("%d/%m/%Y ore %H:%M")

        appuntamenti.append({
            "id": appo["id"],
            "data_formattata": data_formattata,
            "servizio": appo["servizi"]["nome"],
            "stato": appo["stato"]
        })

    # ===============================
    # STORICO COMPLETO APPUNTAMENTI
    # ===============================

    storico_raw = supabase.table("appuntamenti") \
        .select("*, servizi(nome)") \
        .eq("cliente_id", cliente_id) \
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

        storico_appuntamenti.append({
            "id": appo["id"],
            "data_formattata": data_formattata,
            "servizio": appo["servizi"]["nome"],
            "stato": appo.get("stato"),
            "numero_seduta": appo.get("numero_seduta")
        })

        # Calcolo totale sedute completate
        if appo.get("stato") in ["completato", "svolto"]:
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

    return render_template(
        "cliente_dettaglio.html",
        cliente=cliente,
        appuntamenti=appuntamenti,
        tipi_pacchetto=tipi_pacchetto,
        pacchetti_cliente=pacchetti_cliente,
        storico_appuntamenti=storico_appuntamenti,
        stats_totali=totale_sedute,
        stats_rimanenti=sedute_rimanenti,
        ultima_visita=ultima_visita_str,
        prossima_visita=prossima_visita_str
    )


# ===============================
# ASSEGNA PACCHETTO
# ===============================

@app.route("/assegna_pacchetto", methods=["POST"])
@login_required
def assegna_pacchetto():

    cliente_id = request.form["cliente_id"]
    tipo_pacchetto_id = request.form["tipo_pacchetto_id"]

    supabase.table("pacchetti_cliente").insert({
        "cliente_id": cliente_id,
        "tipo_pacchetto_id": tipo_pacchetto_id,
        "sedute_effettuate": 0,
        "stato": "attivo"
    }).execute()

    return redirect(f"/cliente/{cliente_id}")


# ===============================
# SALVA NOTE
# ===============================

@app.route("/cliente/<cliente_id>/note", methods=["POST"])
@login_required
def aggiorna_note(cliente_id):

    note = request.form.get("note_cliniche")

    supabase.table("clienti") \
        .update({"note_cliniche": note}) \
        .eq("id", cliente_id) \
        .execute()

    return redirect(f"/cliente/{cliente_id}")

# ===============================
# GENERA PDF PROMEMORIA
# ===============================

@app.route("/cliente/<cliente_id>/promemoria")
def genera_promemoria(cliente_id):

    cliente = supabase.table("clienti") \
        .select("*") \
        .eq("id", cliente_id) \
        .single() \
        .execute().data

    now = datetime.now().isoformat()

    appuntamenti_raw = supabase.table("appuntamenti") \
        .select("*, servizi(nome)") \
        .eq("cliente_id", cliente_id) \
        .gte("start_datetime", now) \
        .order("start_datetime") \
        .execute().data

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

@app.route("/update_stato", methods=["POST"])
@login_required
def update_stato():

    appuntamento_id = request.form["appuntamento_id"]
    nuovo_stato = request.form["stato"]

    # Aggiorno stato
    supabase.table("appuntamenti").update({
        "stato": nuovo_stato
    }).eq("id", appuntamento_id).execute()

    # =========================
    # SCALAGGIO AUTOMATICO
    # =========================
    if nuovo_stato in ["completato", "svolto"]:

        appuntamento = supabase.table("appuntamenti") \
            .select("*") \
            .eq("id", appuntamento_id) \
            .single() \
            .execute()

        appo = appuntamento.data

        if appo["pacchetto_cliente_id"] and not appo.get("scalato"):

            pacchetto = supabase.table("pacchetti_cliente") \
                .select("*") \
                .eq("id", appo["pacchetto_cliente_id"]) \
                .single() \
                .execute()

            pac = pacchetto.data

            supabase.table("pacchetti_cliente").update({
                "sedute_effettuate": pac["sedute_effettuate"] + 1
            }).eq("id", pac["id"]).execute()

            supabase.table("appuntamenti").update({
                "scalato": True
            }).eq("id", appuntamento_id).execute()

    return redirect(request.referrer)

@app.route("/chiudi_pacchetto/<pacchetto_id>", methods=["POST"])
@login_required
def chiudi_pacchetto(pacchetto_id):

    supabase.table("pacchetti_cliente") \
        .update({"stato": "chiuso"}) \
        .eq("id", pacchetto_id) \
        .execute()

    return redirect(request.referrer)




# ===============================
# INVIO PROMEMORIA EMAIL
# ===============================


@app.route("/invia_promemoria/<appuntamento_id>", methods=["GET"])
@login_required
def invia_promemoria(appuntamento_id):

    RESEND_API_KEY = os.getenv("RESEND_API_KEY")

    from flask import jsonify

    if not RESEND_API_KEY:
        return jsonify({"status": "error", "message": "RESEND_API_KEY non configurata"}), 500

    # Recupero appuntamento con servizio e clienti
    appo = supabase.table("appuntamenti") \
        .select("""
            *,
            servizi(nome),
            appuntamenti_clienti(
                cliente_id,
                clienti(nome,cognome,email)
            )
        """) \
        .eq("id", appuntamento_id) \
        .single() \
        .execute().data

    if not appo:
        return jsonify({"status": "error", "message": "Appuntamento non trovato"}), 404

    relazioni = appo.get("appuntamenti_clienti", [])

    if not relazioni:
        return jsonify({"status": "error", "message": "Cliente non associato"}), 400

    cliente = relazioni[0].get("clienti")

    if not cliente or not cliente.get("email"):
        return jsonify({"status": "error", "message": "Email cliente non disponibile"}), 400

    dt = datetime.fromisoformat(appo["start_datetime"].replace("Z", "+00:00"))
    data_formattata = dt.strftime("%d/%m/%Y")
    ora_formattata = dt.strftime("%H:%M")

    servizio_nome = appo["servizi"]["nome"]
    numero_seduta = appo.get("numero_seduta")

    info_seduta = ""
    if numero_seduta:
        info_seduta = f"\nQuesta sarà la seduta n° {numero_seduta} del tuo pacchetto.\n"

    corpo = f"""
Ciao {cliente['nome']},

Ti ricordo il tuo appuntamento:

Data: {data_formattata}
Orario: {ora_formattata}
Servizio: {servizio_nome}
{info_seduta}
Ti aspetto!

MASSOTERAPIA & PT
Christian Di Tommaso
"""

    try:
        response = requests.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "from": "Gestionale <onboarding@resend.dev>",
                "to": [cliente["email"]],
                "subject": f"Promemoria Appuntamento – {servizio_nome}",
                "text": corpo
            },
            timeout=10
        )

        if response.status_code in [200, 201]:
            return jsonify({"status": "success"})
        else:
            return jsonify({
                "status": "error",
                "message": response.text
            }), 500

    except Exception as e:
        print("Errore invio email Resend:", e)
        return jsonify({"status": "error", "message": str(e)}), 500


# ===============================
# AVVIO SERVER
# ===============================

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5050, debug=True)