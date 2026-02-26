window.eventoSelezionato = null;
let calendar;
let selectedStart;
let selectedEnd;
let serviziData = [];
let tuttiClienti = [];
let clientiSelezionati = [];

document.addEventListener('DOMContentLoaded', function () {

    var calendarEl = document.getElementById('calendar');

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: 'timeGridWeek',
firstDay: 1,   // Settimana che parte da Lunedì

headerToolbar: {
    left: 'prev,next today',
    center: 'title',
    right: 'timeGridWeek,timeGridDay'
},

buttonText: {
    today: 'Oggi',
    week: 'Settimana',
    day: 'Giorno'
},
        height: 'auto',
        expandRows: true,
        initialDate: new Date(),
        locale: 'it',
        selectable: true,
        editable: true,
        slotDuration: "00:15:00",
        snapDuration: "00:15:00",
        slotLabelInterval: "00:30:00",
        slotMinTime: "08:00:00",
        slotMaxTime: "21:00:00",

        // 🍝 Evidenzia fascia pranzo
        eventSources: [
            {
                events: [
                    {
                        daysOfWeek: [1,2,3,4,5,6,0], // Tutti i giorni
                        startTime: "13:30",
                        endTime: "15:00",
                        display: "background",
                        backgroundColor: "#f3f4f6" // grigio soft coerente col layout
                    }
                ]
            }
        ],

        events: function(fetchInfo, successCallback, failureCallback) {

            fetch(`/api/appuntamenti?start=${fetchInfo.startStr}&end=${fetchInfo.endStr}`)
                .then(response => response.json())
                .then(data => {
                    successCallback(data);
                })
                .catch(error => {
                    console.error("Errore caricamento eventi:", error);
                    failureCallback(error);
                });

        },

        select: function(info) {
            selectedStart = info.startStr;

            // Se selezione troppo breve o click singolo → default 60 minuti
            if (!info.end || info.start.getTime() === info.end.getTime()) {
                const endDefault = new Date(info.start.getTime() + 60 * 60000);
                selectedEnd = endDefault.toISOString();
            } else {
                selectedEnd = info.endStr;
            }

            apriModal();
        },

        eventClick: function(info) {
            window.eventoSelezionato = info.event;
            apriModificaModal();
        },

        eventDrop: function(info) {
            aggiornaOrario(info.event);
        },

        eventResize: function(info) {
            aggiornaOrario(info.event);
        },

        eventContent: function(arg) {
            const clienti = arg.event.extendedProps?.clienti || "";
            const servizio = arg.event.extendedProps?.servizio || "";

            const wrapper = document.createElement("div");
            wrapper.style.display = "flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.gap = "2px";

            const nomeEl = document.createElement("div");
            nomeEl.textContent = clienti;
            nomeEl.style.fontWeight = "600";
            nomeEl.style.fontSize = "12px";
            nomeEl.style.letterSpacing = "0.2px";

            const servizioEl = document.createElement("div");
            servizioEl.textContent = servizio;
            servizioEl.style.fontSize = "11px";
            servizioEl.style.opacity = "0.85";

            wrapper.appendChild(nomeEl);
            if (servizio) {
                wrapper.appendChild(servizioEl);
            }

            return { domNodes: [wrapper] };
        },
        eventDidMount: function(info) {

            const servizio = info.event.extendedProps?.servizio;
             if (!servizio) return;

            // 🎨 APPLE MINIMAL GREY PALETTE

            if (servizio === "Massoterapia") {
                info.el.style.backgroundColor = "#111827"; // quasi nero elegante
            }

            if (servizio === "Ginnastica Posturale") {
                info.el.style.backgroundColor = "#1f2937"; // grigio antracite
            }

            if (servizio === "Rieducazione Motoria") {
                info.el.style.backgroundColor = "#374151"; // grigio medio scuro
            }

            if (servizio === "Check") {
                info.el.style.backgroundColor = "#4b5563"; // grigio medio
            }

            if (servizio === "Ginnastica Posturale di Coppia") {
                info.el.style.backgroundColor = "#6b7280"; // grigio soft chiaro
            }

            // Testo sempre bianco per contrasto
            info.el.style.color = "#ffffff";
},
    });

    calendar.render();

    caricaClienti(); // ora carica array per ricerca
    caricaServizi();

    // ===============================
    // OTTIMIZZAZIONE MOBILE iPHONE
    // ===============================
    if (window.innerWidth < 768) {

        // Migliora leggibilità eventi e bottoni
        const style = document.createElement("style");
        style.innerHTML = `
            .fc-event {
                font-size: 14px !important;
                padding: 4px !important;
            }

            .fc-toolbar-title {
                font-size: 18px !important;
            }

            .fc-button {
                padding: 8px 12px !important;
                font-size: 14px !important;
            }
        `;
        document.head.appendChild(style);

        // Bottone flottante "+"
        const fab = document.createElement("div");
        fab.innerHTML = "+";
        fab.style.position = "fixed";
        fab.style.bottom = "20px";
        fab.style.right = "20px";
        fab.style.width = "65px";
        fab.style.height = "65px";
        fab.style.borderRadius = "50%";
        fab.style.background = "#2563eb";
        fab.style.color = "white";
        fab.style.display = "flex";
        fab.style.alignItems = "center";
        fab.style.justifyContent = "center";
        fab.style.fontSize = "32px";
        fab.style.boxShadow = "0 8px 20px rgba(0,0,0,0.25)";
        fab.style.zIndex = "9999";
        fab.style.cursor = "pointer";

        fab.onclick = function() {
            apriModal();
        };

        document.body.appendChild(fab);
    }

});

function caricaPacchettiCliente(clienteId) {

    const select = document.getElementById("pacchettoSelect");
    if (!select) return;

    select.innerHTML = '<option value="">Nessun pacchetto</option>';

    fetch('/api/pacchetti_attivi/' + clienteId)
        .then(res => res.json())
        .then(data => {

            data.forEach(pac => {

                const option = document.createElement("option");
                option.value = pac.id;
                option.text = pac.nome + " (" + pac.sedute_rimanenti + " rimaste)";
                option.dataset.servizio = pac.servizio_id;

                select.appendChild(option);
            });
        });
}


/* ===============================
   AGGIORNA ORARIO (DRAG & RESIZE)
=================================*/

function aggiornaOrario(evento) {

    fetch('/api/appuntamenti/' + evento.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            start_datetime: evento.start.toISOString(),
            end_datetime: evento.end.toISOString()
        })
    }).then(() => {
        calendar.refetchEvents();
    });
}


/* ===============================
   MODALE NUOVO APPUNTAMENTO
=================================*/

function apriModal() {
    clientiSelezionati = [];
    document.getElementById("eventoModal").style.display = "block";
    inizializzaRicercaClienti();
    aggiornaClientiSelezionati();
}

function chiudiModal() {
    document.getElementById("eventoModal").style.display = "none";
}

function salvaEvento() {

    const servizioId = document.getElementById("servizioSelect").value;
    const pacchettoId = document.getElementById("pacchettoSelect")?.value || null;

    if (clientiSelezionati.length === 0 || !servizioId) {
        mostraToast("Seleziona almeno un cliente e un servizio", "warning");
        return;
    }

    fetch('/api/appuntamenti', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            clienti_ids: clientiSelezionati.map(c => c.id),
            servizio_id: servizioId,
            pacchetto_cliente_id: pacchettoId,
            start_datetime: selectedStart,
            end_datetime: selectedEnd,
            stato: "prenotato",
            note: "",
            durata_minuti: Math.round((new Date(selectedEnd) - new Date(selectedStart)) / 60000)
        })
    })
    .then(response => {
        if (!response.ok) {
            throw new Error("Errore nel salvataggio");
        }
        return response.json();
    })
    .then(() => {
        chiudiModal();
        calendar.refetchEvents();
        clientiSelezionati = [];
        aggiornaClientiSelezionati();
    })
    .catch(error => {
        console.error("Errore:", error);
        mostraToast("Errore nel creare appuntamento", "error");
    });
}


/* ===============================
   MODALE MODIFICA APPUNTAMENTO
=================================*/

function getColoreServizio(servizio) {

    if (servizio === "Massoterapia") return "#111827";
    if (servizio === "Ginnastica Posturale") return "#1f2937";
    if (servizio === "Rieducazione Motoria") return "#374151";
    if (servizio === "Check") return "#4b5563";
    if (servizio === "Ginnastica Posturale di Coppia") return "#6b7280";

    return "#111827";
}

function apriModificaModal() {

    const extended = window.eventoSelezionato._def?.extendedProps || {};

    const clienti = extended.clienti || "";
    const clientiIds = extended.clienti_ids || [];
    const servizio = extended.servizio || "";
    const numeroSeduta = extended.numero_seduta;

    let titoloHTML = "";

    if (clienti) {

        // Se abbiamo array ID clienti (multi cliente)
        if (Array.isArray(clientiIds) && clientiIds.length > 0) {

            clientiIds.forEach((id, index) => {

                const nomeVisualizzato = Array.isArray(clienti)
                    ? clienti[index]
                    : clienti;

                titoloHTML += `
                    <div style="
                        font-size:18px;
                        font-weight:600;
                        color:${getColoreServizio(servizio)};
                    ">
                        <a href="/cliente/${id}"
                           style="
                              color:${getColoreServizio(servizio)};
                              text-decoration:none;
                           ">
                            ${nomeVisualizzato}
                        </a>
                    </div>
                `;
            });

        } else {

            // fallback se abbiamo solo nome ma non ID
            titoloHTML += `
                <div style="
                    font-size:18px;
                    font-weight:600;
                    color:${getColoreServizio(servizio)};
                ">
                    ${clienti}
                </div>
            `;
        }
    }

    if (servizio) {
        titoloHTML += `
            <div style="
                font-size:13px;
                margin-top:6px;
                font-variant: small-caps;
                letter-spacing:1px;
                color:#6b7280;
            ">
                ${servizio}
            </div>
        `;
    }

    if (numeroSeduta) {
        titoloHTML += `
            <div style="margin-top:10px;">
                <span style="
                    display:inline-block;
                    padding:5px 12px;
                    border-radius:20px;
                    background:linear-gradient(135deg,#2a9d8f,#21867a);
                    color:white;
                    font-size:12px;
                    font-weight:600;
                    letter-spacing:0.3px;
                ">
                    Seduta ${numeroSeduta}
                </span>
            </div>
        `;
    }

    const coloreBarra = getColoreServizio(servizio);

    document.querySelector("#modificaModal h3").innerHTML = `
        <div style="
            border-left:4px solid ${coloreBarra};
            padding-left:14px;
            margin-left:4px;
        ">
            ${titoloHTML}
        </div>
    `;

    const start = window.eventoSelezionato.start;
    const end = window.eventoSelezionato.end;

    const data = start.toISOString().split("T")[0];
    const oraInizio = start.toTimeString().slice(0,5);
    const oraFine = end.toTimeString().slice(0,5);

    document.getElementById("dataModifica").value = data;
    document.getElementById("oraInizioModifica").value = oraInizio;
    document.getElementById("oraFineModifica").value = oraFine;

    document.getElementById("statoSelect").value =
        extended.stato || "prenotato";

    const modal = document.getElementById("modificaModal");
    if (!modal) return;
    modal.style.display = "block";   // assicura visibilità
    modal.classList.add("modal-active");

    // 🎯 Restyle bottone elimina PREMIUM (rotondo con icona cestino bianca)
    const bottoniModifica = modal.querySelectorAll("button");
    if (bottoniModifica.length >= 3) {
        const deleteBtn = bottoniModifica[2];

        deleteBtn.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" fill="white" viewBox="0 0 24 24">
                <path d="M3 6h18" stroke="white" stroke-width="2" stroke-linecap="round"/>
                <path d="M8 6V4h8v2" stroke="white" stroke-width="2" stroke-linecap="round"/>
                <rect x="6" y="6" width="12" height="14" rx="2" stroke="white" stroke-width="2" fill="none"/>
            </svg>
        `;

        deleteBtn.style.width = "56px";
        deleteBtn.style.height = "56px";
        deleteBtn.style.borderRadius = "50%";
        deleteBtn.style.display = "flex";
        deleteBtn.style.alignItems = "center";
        deleteBtn.style.justifyContent = "center";
        deleteBtn.style.margin = "24px auto 0 auto";
        deleteBtn.style.background = "linear-gradient(135deg,#ef4444,#dc2626)";
        deleteBtn.style.boxShadow = "0 10px 25px rgba(220,38,38,0.4)";
        deleteBtn.style.padding = "0";
        deleteBtn.style.border = "none";
        deleteBtn.style.cursor = "pointer";
        deleteBtn.style.transition = "all 0.2s ease";

        deleteBtn.onmouseenter = () => {
            deleteBtn.style.transform = "translateY(-2px) scale(1.05)";
            deleteBtn.style.boxShadow = "0 14px 30px rgba(220,38,38,0.5)";
        };

        deleteBtn.onmouseleave = () => {
            deleteBtn.style.transform = "none";
            deleteBtn.style.boxShadow = "0 10px 25px rgba(220,38,38,0.4)";
        };
    }
}
function chiudiModificaModal() {
    const modal = document.getElementById("modificaModal");
    if (!modal) return;

    modal.classList.remove("modal-active");
    modal.style.display = "none";  // chiusura reale del modal
}


/* ===============================
   CHIUSURA MODALI (CLICK FUORI + ESC)
=================================*/

window.addEventListener("click", function(event) {

    const eventoModal = document.getElementById("eventoModal");
    const clienteModal = document.getElementById("clienteModal");
    const modificaModal = document.getElementById("modificaModal");

    if (eventoModal && event.target === eventoModal) {
        chiudiModal();
    }

    if (clienteModal && event.target === clienteModal) {
        chiudiModalCliente();
    }

    if (modificaModal && event.target === modificaModal) {
        chiudiModificaModal();
    }
});

window.addEventListener("keydown", function(event) {

    if (event.key !== "Escape") return;

    const eventoModal = document.getElementById("eventoModal");
    const clienteModal = document.getElementById("clienteModal");
    const modificaModal = document.getElementById("modificaModal");

    if (eventoModal && eventoModal.style.display === "block") {
        chiudiModal();
    }

    if (clienteModal && clienteModal.style.display === "block") {
        chiudiModalCliente();
    }

    if (modificaModal && modificaModal.style.display === "block") {
        chiudiModificaModal();
    }
});

function salvaModifiche() {

    const data = document.getElementById("dataModifica").value;
    const oraInizio = document.getElementById("oraInizioModifica").value;
    const oraFine = document.getElementById("oraFineModifica").value;
    const stato = document.getElementById("statoSelect").value;

    const start_datetime = data + "T" + oraInizio + ":00";
    const end_datetime = data + "T" + oraFine + ":00";

    fetch('/api/appuntamenti/' + window.eventoSelezionato.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            start_datetime: start_datetime,
            end_datetime: end_datetime,
            stato: stato
        })
    }).then(() => {
        chiudiModificaModal();
        calendar.refetchEvents();
    });
}


function eliminaEvento() {

    if (!confirm("Sei sicuro di voler eliminare l'appuntamento?")) return;

    fetch('/api/appuntamenti/' + window.eventoSelezionato.id, {
        method: 'DELETE'
    }).then(() => {
        chiudiModificaModal();
        calendar.refetchEvents();
    });
}

function inviaPromemoria() {
    if (!window.eventoSelezionato) {
        mostraToast("Nessun appuntamento selezionato", "error");
        return;
    }

    fetch('/invia_promemoria/' + window.eventoSelezionato.id)
        .then(async (response) => {
            const contentType = response.headers.get("content-type");

            if (!response.ok) {
                const text = await response.text();
                console.error("Errore backend:", text);
                throw new Error("Errore backend");
            }

            if (contentType && contentType.includes("application/json")) {
                return response.json();
            } else {
                const text = await response.text();
                console.error("Risposta non JSON:", text);
                throw new Error("Risposta non valida");
            }
        })
        .then(data => {
            if (data.status === "success") {
                mostraToast("Email inviata con successo", "success");
            } else {
                mostraToast("Errore invio email", "error");
            }
        })
        .catch(error => {
            console.error("Errore invio promemoria:", error);
            mostraToast("Errore invio email", "error");
        });
}


/* ===============================
   CLIENTI
=================================*/

function caricaClienti() {
    fetch('/api/clienti')
        .then(res => res.json())
        .then(data => {
            tuttiClienti = data;
        });
}

function inizializzaRicercaClienti() {

    const searchInput = document.getElementById("searchCliente");
    const risultatiDiv = document.getElementById("risultatiClienti");
    const selezionatiDiv = document.getElementById("clientiSelezionati");

    searchInput.value = "";
    risultatiDiv.innerHTML = "";
    risultatiDiv.style.display = "none";

    searchInput.oninput = function() {

        const valore = this.value.toLowerCase();
        risultatiDiv.innerHTML = "";

        if (valore.length < 1) {
            risultatiDiv.style.display = "none";
            return;
        }

        const filtrati = tuttiClienti.filter(c =>
            c.nome.toLowerCase().includes(valore) ||
            c.cognome.toLowerCase().includes(valore)
        );

        filtrati.forEach(cliente => {

            const div = document.createElement("div");
            div.textContent = cliente.nome + " " + cliente.cognome;

            div.onclick = function() {

                if (clientiSelezionati.length >= 2) {
                    mostraToast("Puoi selezionare massimo 2 clienti", "info");
                    return;
                }

                if (!clientiSelezionati.find(c => c.id === cliente.id)) {
                    clientiSelezionati.push(cliente);
                    aggiornaClientiSelezionati();
                }

                risultatiDiv.style.display = "none";
                searchInput.value = "";
            };

            risultatiDiv.appendChild(div);
        });

        risultatiDiv.style.display = "block";
    };
}

function aggiornaClientiSelezionati() {

    const selezionatiDiv = document.getElementById("clientiSelezionati");
    selezionatiDiv.innerHTML = "";

    clientiSelezionati.forEach(cliente => {

        const badge = document.createElement("span");
        badge.textContent = cliente.nome + " " + cliente.cognome + " ✕";

        badge.onclick = function() {
            clientiSelezionati = clientiSelezionati.filter(c => c.id !== cliente.id);
            aggiornaClientiSelezionati();
        };

        selezionatiDiv.appendChild(badge);
    });

    if (clientiSelezionati.length > 0) {
    caricaPacchettiCliente(clientiSelezionati[0].id);
    } else {
    document.getElementById("pacchettoSelect").innerHTML =
        '<option value="">Nessun pacchetto</option>';
    }
}


/* ===============================
   MODALE CLIENTE
=================================*/

function apriModalCliente() {
    document.getElementById("clienteModal").style.display = "block";
}

function chiudiModalCliente() {
    document.getElementById("clienteModal").style.display = "none";
}

function salvaCliente() {
    fetch("/api/clienti", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            nome: document.getElementById("nomeCliente").value,
            cognome: document.getElementById("cognomeCliente").value,
            telefono: document.getElementById("telefonoCliente").value,
            email: document.getElementById("emailCliente").value,
            note_cliniche: document.getElementById("noteClinicheCliente").value
        })
    })
    .then(res => res.json())
    .then(() => {
        chiudiModalCliente();
        location.reload();
    });
}

/* ===============================
   SERVIZI
=================================*/

function caricaServizi() {
    fetch('/api/servizi')
        .then(res => res.json())
        .then(data => {
            serviziData = data;
            const select = document.getElementById("servizioSelect");
            select.innerHTML = "";
            data.forEach(servizio => {
                let option = document.createElement("option");
                option.value = servizio.id;
                option.text = servizio.nome;
                select.appendChild(option);
            });
        });
}

/* ===============================
   TOAST NOTIFICHE (SaaS Mode)
=================================*/

function mostraToast(messaggio, tipo = "success") {

    const modal = document.getElementById("modificaModal");
    if (!modal) return;

    // Prende il bottone "Invia Promemoria" (primo bottone nella modale)
    const bottoni = modal.querySelectorAll("button");
    if (!bottoni.length) return;

    const bottone = bottoni[0];

    // Rimuove eventuale toast precedente
    const vecchio = modal.querySelector(".toast-inline");
    if (vecchio) vecchio.remove();

    const toast = document.createElement("div");
    toast.className = `toast-inline toast-${tipo}`;

    const icona = tipo === "success" ? "✔" : "✖";

    toast.innerHTML = `
        <div class="toast-content">
            <span class="toast-icon">${icona}</span>
            <span class="toast-message">${messaggio}</span>
        </div>
        <div class="toast-progress"></div>
    `;

    bottone.insertAdjacentElement("afterend", toast);

    // Trigger animazione
    requestAnimationFrame(() => {
        toast.classList.add("toast-show");
    });

    // Animazione barra progresso
    const progress = toast.querySelector(".toast-progress");
    progress.style.animation = "toastProgress 2.5s linear forwards";

    setTimeout(() => {
        toast.classList.remove("toast-show");
        setTimeout(() => toast.remove(), 300);
    }, 2500);
}