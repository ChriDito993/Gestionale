window.eventoSelezionato = null;
let calendar;
let selectedStart;
let selectedEnd;
let serviziData = [];
let tuttiClienti = [];
let clientiSelezionati = [];
const MOBILE_BREAKPOINT = 900;
const DEFAULT_APPOINTMENT_MINUTES = 60;
const SERVIZIO_COLORI = {
    "massoterapia": "#0f766e",
    "ginnastica posturale / personal training": "#1f2937",
    "rieducazione motoria": "#2a9d8f",
    "check": "#475569",
    "ginnastica posturale di coppia": "#2f5d56"
};
const FILTRI_CALENDARIO_DEFAULT = Object.freeze({
    stato: "",
    servizio_id: "",
    cliente: "",
    data_da: "",
    data_a: ""
});
let filtriCalendario = { ...FILTRI_CALENDARIO_DEFAULT };
let filtroClienteDebounceTimer;

function isMobileViewport() {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

function impostaSelezioneDaData(startDate) {
    const start = new Date(startDate);
    const end = new Date(start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);
    selectedStart = formatDateTimeForApi(start);
    selectedEnd = formatDateTimeForApi(end);
}

function calcolaStartDefaultPerMobile() {
    const viewDate = calendar ? new Date(calendar.getDate()) : new Date();
    const now = new Date();
    const isToday = viewDate.toDateString() === now.toDateString();

    const start = new Date(viewDate);
    start.setHours(9, 0, 0, 0);

    if (isToday && now > start) {
        start.setHours(now.getHours(), now.getMinutes(), 0, 0);
        const roundedMinutes = Math.ceil(start.getMinutes() / 15) * 15;
        start.setMinutes(roundedMinutes, 0, 0);
    }

    if (start.getHours() >= 21) {
        start.setHours(20, 0, 0, 0);
    }

    return start;
}

function creaFabMobile() {
    if (!isMobileViewport() || document.getElementById("mobileAddFab")) return;

    const fab = document.createElement("button");
    fab.type = "button";
    fab.id = "mobileAddFab";
    fab.className = "mobile-add-fab";
    fab.setAttribute("aria-label", "Nuovo appuntamento");
    fab.textContent = "+";

    fab.addEventListener("click", function() {
        impostaSelezioneDaData(calcolaStartDefaultPerMobile());
        apriModal();
    });

    document.body.appendChild(fab);
}

function formatDateForInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatTimeForInput(date) {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

function formatDateTimeForApi(date) {
    return `${formatDateForInput(date)}T${formatTimeForInput(date)}:00`;
}

function sincronizzaCampiDataOraNuovoEvento() {
    const inputData = document.getElementById("eventoData");
    const inputOraInizio = document.getElementById("eventoOraInizio");
    const inputOraFine = document.getElementById("eventoOraFine");
    if (!inputData || !inputOraInizio || !inputOraFine) return;

    const start = selectedStart ? new Date(selectedStart) : calcolaStartDefaultPerMobile();
    let end = selectedEnd ? new Date(selectedEnd) : null;
    if (!end || Number.isNaN(end.getTime()) || end <= start) {
        end = new Date(start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);
    }

    inputData.value = formatDateForInput(start);
    inputOraInizio.value = formatTimeForInput(start);
    inputOraFine.value = formatTimeForInput(end);
}

function leggiDataOraDalModalNuovoEvento() {
    const data = document.getElementById("eventoData")?.value;
    const oraInizio = document.getElementById("eventoOraInizio")?.value;
    const oraFine = document.getElementById("eventoOraFine")?.value;

    if (!data || !oraInizio || !oraFine) return null;

    const startLocal = new Date(`${data}T${oraInizio}:00`);
    const endLocal = new Date(`${data}T${oraFine}:00`);

    if (Number.isNaN(startLocal.getTime()) || Number.isNaN(endLocal.getTime())) {
        return null;
    }

    return { startLocal, endLocal };
}

function setButtonLoading(button, loading, options = {}) {
    if (!button) return;

    const {
        label = "Salvataggio...",
        replaceContent = true
    } = options;

    if (loading) {
        if (!button.dataset.originalHtml) {
            button.dataset.originalHtml = button.innerHTML;
        }
        button.disabled = true;
        button.classList.add("is-loading");
        button.setAttribute("aria-busy", "true");
        if (replaceContent) {
            button.textContent = label;
        }
        return;
    }

    button.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
    if (replaceContent && button.dataset.originalHtml) {
        button.innerHTML = button.dataset.originalHtml;
    }
}

async function parseJsonSafely(response) {
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) return null;
    try {
        return await response.json();
    } catch (_error) {
        return null;
    }
}

function getApiErrorMessage(payload, fallbackMessage) {
    if (!payload || typeof payload !== "object") return fallbackMessage;

    const candidate = payload.error || payload.message || payload.detail;
    if (!candidate || typeof candidate !== "string") return fallbackMessage;

    const requestId = payload.request_id;
    if (requestId && typeof requestId === "string") {
        return `${candidate} (ID: ${requestId})`;
    }

    return candidate;
}

async function fetchJsonOrThrow(url, options = {}, fallbackMessage = "Operazione non riuscita") {
    let response;
    try {
        response = await fetch(url, options);
    } catch (networkError) {
        const error = new Error("Errore di rete. Controlla la connessione e riprova.");
        error.cause = networkError;
        throw error;
    }

    const payload = await parseJsonSafely(response);

    if (!response.ok) {
        const error = new Error(getApiErrorMessage(payload, fallbackMessage));
        error.status = response.status;
        error.payload = payload;
        throw error;
    }

    return payload;
}

function buildAppuntamentiUrl(fetchInfo) {
    const params = new URLSearchParams({
        start: fetchInfo.startStr,
        end: fetchInfo.endStr
    });

    if (filtriCalendario.stato) params.set("stato", filtriCalendario.stato);
    if (filtriCalendario.servizio_id) params.set("servizio_id", filtriCalendario.servizio_id);
    if (filtriCalendario.cliente) params.set("cliente", filtriCalendario.cliente);
    if (filtriCalendario.data_da) params.set("data_da", filtriCalendario.data_da);
    if (filtriCalendario.data_a) params.set("data_a", filtriCalendario.data_a);

    return `/api/appuntamenti?${params.toString()}`;
}

function aggiornaFiltriCalendarioDaUI(refetch = true) {
    const filtroStato = document.getElementById("filtroStato");
    const filtroServizio = document.getElementById("filtroServizio");
    const filtroCliente = document.getElementById("filtroCliente");
    const filtroDataDa = document.getElementById("filtroDataDa");
    const filtroDataA = document.getElementById("filtroDataA");

    if (!filtroStato || !filtroServizio || !filtroCliente || !filtroDataDa || !filtroDataA) {
        return;
    }

    let dataDa = filtroDataDa.value || "";
    let dataA = filtroDataA.value || "";

    // Se invertite, le riallineiamo automaticamente per non bloccare il flusso.
    if (dataDa && dataA && dataDa > dataA) {
        const tmp = dataDa;
        dataDa = dataA;
        dataA = tmp;
        filtroDataDa.value = dataDa;
        filtroDataA.value = dataA;
    }

    filtriCalendario = {
        stato: (filtroStato.value || "").trim(),
        servizio_id: (filtroServizio.value || "").trim(),
        cliente: (filtroCliente.value || "").trim(),
        data_da: dataDa,
        data_a: dataA
    };

    if (refetch && calendar) {
        calendar.refetchEvents();
    }
}

function resetFiltriCalendario() {
    const filtroStato = document.getElementById("filtroStato");
    const filtroServizio = document.getElementById("filtroServizio");
    const filtroCliente = document.getElementById("filtroCliente");
    const filtroDataDa = document.getElementById("filtroDataDa");
    const filtroDataA = document.getElementById("filtroDataA");

    if (filtroStato) filtroStato.value = "";
    if (filtroServizio) filtroServizio.value = "";
    if (filtroCliente) filtroCliente.value = "";
    if (filtroDataDa) filtroDataDa.value = "";
    if (filtroDataA) filtroDataA.value = "";

    filtriCalendario = { ...FILTRI_CALENDARIO_DEFAULT };
    if (calendar) calendar.refetchEvents();
}

function inizializzaFiltriCalendario() {
    const filtroStato = document.getElementById("filtroStato");
    const filtroServizio = document.getElementById("filtroServizio");
    const filtroCliente = document.getElementById("filtroCliente");
    const filtroDataDa = document.getElementById("filtroDataDa");
    const filtroDataA = document.getElementById("filtroDataA");
    const resetBtn = document.getElementById("resetFiltriCalendario");

    if (!filtroStato || !filtroServizio || !filtroCliente || !filtroDataDa || !filtroDataA || !resetBtn) {
        return;
    }

    filtroStato.addEventListener("change", () => aggiornaFiltriCalendarioDaUI(true));
    filtroServizio.addEventListener("change", () => aggiornaFiltriCalendarioDaUI(true));
    filtroDataDa.addEventListener("change", () => aggiornaFiltriCalendarioDaUI(true));
    filtroDataA.addEventListener("change", () => aggiornaFiltriCalendarioDaUI(true));

    filtroCliente.addEventListener("input", () => {
        clearTimeout(filtroClienteDebounceTimer);
        filtroClienteDebounceTimer = setTimeout(() => {
            aggiornaFiltriCalendarioDaUI(true);
        }, 240);
    });

    resetBtn.addEventListener("click", resetFiltriCalendario);
    aggiornaFiltriCalendarioDaUI(false);
}

document.addEventListener('DOMContentLoaded', function () {

    var calendarEl = document.getElementById('calendar');
    const mobileMode = isMobileViewport();

    document.body.classList.toggle("mobile-calendar-mode", mobileMode);

    calendar = new FullCalendar.Calendar(calendarEl, {
        initialView: mobileMode ? 'timeGridDay' : 'timeGridWeek',
firstDay: 1,   // Settimana che parte da Lunedì

headerToolbar: {
    left: mobileMode ? 'prev,next today' : 'prev,next today',
    center: 'title',
    right: mobileMode ? '' : 'timeGridWeek,timeGridDay'
},

buttonText: {
    today: 'Oggi',
    week: 'Settimana',
    day: 'Giorno'
},
        dayHeaderFormat: mobileMode
            ? { weekday: 'short', day: '2-digit', month: '2-digit' }
            : { weekday: 'short', day: 'numeric', month: 'numeric' },
        height: 'auto',
        contentHeight: 'auto',
        expandRows: true,
        nowIndicator: true,
        lazyFetching: true,
        progressiveEventRendering: true,
        rerenderDelay: 50,
        initialDate: new Date(),
        locale: 'it',
        selectable: true,
        selectMirror: true, // mostra anteprima evento mentre trascini (stile Apple Calendar)
        editable: !mobileMode,
        eventStartEditable: !mobileMode,
        eventDurationEditable: !mobileMode,
        longPressDelay: mobileMode ? 120 : 300,
        eventLongPressDelay: mobileMode ? 120 : 300,
        selectLongPressDelay: mobileMode ? 120 : 300,
        slotEventOverlap: true, // permette agli eventi di sovrapporsi
        // Visual grid every 30 minutes, but allow dragging/creating every 15 minutes
        slotDuration: "00:30:00",   // linee calendario
        snapDuration: "00:15:00",   // precisione drag a 15 minuti
        slotLabelInterval: "01:00:00", // mostra solo ore piene nella colonna
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
            fetch(buildAppuntamentiUrl(fetchInfo), {
                cache: "no-store"
            })
                .then(r => r.json())
                .then(successCallback)
                .catch(error => {
                    console.error("Errore caricamento eventi:", error);
                    failureCallback(error);
                });
        },

        // Preview visivo mentre trascini per creare appuntamento
        selectAllow: () => true,

        select: function(info) {
            selectedStart = formatDateTimeForApi(info.start);

            // Se selezione troppo breve o click singolo → default 60 minuti
            if (!info.end || info.start.getTime() === info.end.getTime()) {
                const endDefault = new Date(info.start.getTime() + 60 * 60000);
                selectedEnd = formatDateTimeForApi(endDefault);
            } else {
                selectedEnd = formatDateTimeForApi(info.end);
            }

            apriModal();
        },

        dateClick: function(info) {
            if (!mobileMode) return;
            impostaSelezioneDaData(info.date);
            apriModal();
        },

        eventClick: function(info) {
            if (mobileMode) {
                info.jsEvent?.preventDefault?.();
                return;
            }
            window.eventoSelezionato = info.event;
            apriModificaModal();
        },

        eventDrop: info => aggiornaOrario(info),
        eventResize: info => aggiornaOrario(info),

        eventContent: function(arg) {
            // Handle preview while dragging (mirror event)
            if (arg.isMirror) {
                const wrapper = document.createElement("div");
                wrapper.style.fontSize = "12px";
                wrapper.style.fontWeight = "600";
                wrapper.style.opacity = "0.8";
                wrapper.style.color = "#000000"; // testo nero per anteprima

                const start = arg.event.start;
                const end = arg.event.end;

                if (start && end) {
                    const startStr = start.toTimeString().slice(0,5);
                    const endStr = end.toTimeString().slice(0,5);
                    wrapper.textContent = `${startStr} – ${endStr}`;
                } else {
                    wrapper.textContent = "Nuovo appuntamento";
                }

                return { domNodes: [wrapper] };
            }
            const clienti = arg.event.extendedProps?.clienti || "";
            const servizio = arg.event.extendedProps?.servizio || "";

            const wrapper = document.createElement("div");
            wrapper.style.display = "flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.gap = "2px";

            const nomeEl = document.createElement("div");
            nomeEl.className = "fc-event-title";
            // Formattazione nomi clienti (es: "👥 Monica + Angela")
            let displayClienti = clienti;

            if (clienti.includes("+")) {
                const parti = clienti.split("+").map(n => n.trim());

                const firstNames = parti.map(nomeCompleto => {
                    const parts = nomeCompleto.split(" ");
                    return parts[0];
                });

                displayClienti = `👥 ${firstNames.join(" + ")}`;
            }

            nomeEl.textContent = displayClienti;
            nomeEl.style.fontWeight = "600";
            nomeEl.style.letterSpacing = "0.2px";

            const servizioEl = document.createElement("div");
            servizioEl.textContent = servizio;
            servizioEl.className = "fc-event-service";
            servizioEl.style.opacity = "0.85";

            wrapper.appendChild(nomeEl);
            if (servizio) {
                wrapper.appendChild(servizioEl);
            }

            return { domNodes: [wrapper] };
        },
        eventDidMount: function(info) {
            // 🎯 Preview evento mentre trascini per creare appuntamento
            if (info.isMirror) {
                info.el.style.backgroundColor = "rgba(107,114,128,0.25)"; // grigio soft trasparente
                info.el.style.border = "1px dashed rgba(55,65,81,0.6)";
                info.el.style.color = "#111827";
                info.el.style.boxShadow = "none";
                return; // evita applicazione colori servizio
            }

            const servizio = info.event.extendedProps?.servizio;
             if (!servizio) return;

            const coloreServizio = getColoreServizio(servizio);
            info.el.style.backgroundColor = coloreServizio;
            info.el.style.borderColor = "rgba(255,255,255,0.22)";

            // Testo sempre bianco per contrasto
            info.el.style.color = "#ffffff";

            // ✔ Badge minimal reminder WhatsApp inviato
            if (info.event.extendedProps?.reminder_whatsapp) {

                const badge = document.createElement("div");
                badge.textContent = "✔";

                badge.style.position = "absolute";
                badge.style.top = "4px";
                badge.style.right = "6px";
                badge.style.width = "16px";
                badge.style.height = "16px";
                badge.style.borderRadius = "50%";
                badge.style.display = "flex";
                badge.style.alignItems = "center";
                badge.style.justifyContent = "center";
                badge.style.fontSize = "10px";
                badge.style.fontWeight = "700";
                badge.style.background = "rgba(255,255,255,0.95)";
                badge.style.color = "#2a9d8f";
                badge.style.boxShadow = "0 2px 6px rgba(0,0,0,0.15)";

                info.el.style.position = "relative";
                info.el.appendChild(badge);
            }
        },
    });

    calendar.render();
    inizializzaFiltriCalendario();

    function aggiornaDashboardOggi() {
        fetch('/api/appuntamenti_oggi')
            .then(res => res.json())
            .then(data => {

                const dayEl = document.getElementById("dayCount");
                const labelEl = document.getElementById("dayLabel");

                if (!dayEl || !labelEl) return;

                dayEl.textContent = data.totale;

                const oggi = new Date();
                const options = { day: '2-digit', month: 'long', year: 'numeric' };
                labelEl.textContent = oggi.toLocaleDateString('it-IT', options);

                dayEl.style.transform = "scale(1.1)";
                dayEl.style.transition = "transform 0.2s ease";

                setTimeout(() => {
                    dayEl.style.transform = "scale(1)";
                }, 200);
            });
    }

    function aggiornaDashboardSettimana() {

        const eventi = calendar.getEvents();
        const oggi = calendar.getDate(); // usa la settimana visualizzata nel calendario

        const day = oggi.getDay();
        const diffToMonday = (day === 0 ? -6 : 1) - day;
        const monday = new Date(oggi);
        monday.setDate(oggi.getDate() + diffToMonday);
        monday.setHours(0,0,0,0);

        const sunday = new Date(monday.getTime() + 7 * 86400000);

        let count = 0;

        eventi.forEach(evento => {

            // Ignora eventi di background (es. fascia pranzo)
            if (evento.display === 'background') return;

            const dataEvento = evento.start;

            if (dataEvento >= monday && dataEvento < sunday) {
                count++; // conta 1 appuntamento per evento (non per slot)
            }
        });

        const weekEl = document.getElementById("weekCount");
        if (weekEl) weekEl.textContent = count;

        // 🔥 Range settimana dinamico (Lun - Dom)
        const options = { day: '2-digit', month: 'short' };
        const lunediLabel = monday.toLocaleDateString('it-IT', options);
        const domenica = new Date(sunday.getTime() - 86400000);
        const domenicaLabel = domenica.toLocaleDateString('it-IT', options);

        const weekSub = document.getElementById("weekRangeLabel");
        if (weekSub) {
            weekSub.textContent = `${lunediLabel} – ${domenicaLabel}`;
            weekSub.classList.remove("week-range-animate");
            requestAnimationFrame(() => weekSub.classList.add("week-range-animate"));
        }
    }

    calendar.on('eventsSet', aggiornaDashboardSettimana);
    calendar.on('datesSet', aggiornaDashboardSettimana);

    // ===============================
    // AUTO OPEN EVENT FROM URL (?open_event=ID)
    // ===============================

    const params = new URLSearchParams(window.location.search);
    const openEventId = params.get("open_event");

    if (openEventId && !mobileMode) {
        let autoOpenHandled = false;
        const cleanUrl = window.location.origin + window.location.pathname;

        const tryAutoOpenEventFromUrl = function() {
            if (autoOpenHandled) return;
            const eventToOpen = calendar.getEventById(openEventId);
            if (!eventToOpen) return;

            autoOpenHandled = true;
            window.eventoSelezionato = eventToOpen;
            apriModificaModal();

            // Pulisce URL per evitare riapertura al refresh
            window.history.replaceState({}, document.title, cleanUrl);
            calendar.off('eventsSet', tryAutoOpenEventFromUrl);
        };

        calendar.on('eventsSet', tryAutoOpenEventFromUrl);
        tryAutoOpenEventFromUrl();
    } else if (openEventId && mobileMode) {
        const cleanUrl = window.location.origin + window.location.pathname;
        window.history.replaceState({}, document.title, cleanUrl);
    }

    caricaClienti(); // ora carica array per ricerca
    caricaServizi();
    aggiornaDashboardOggi();

    // ===============================
    // MODAL PACCHETTI ATTIVI
    // ===============================

    const openPacchettiBtn = document.getElementById("openPacchettiAttivi");
    const pacchettiModal = document.getElementById("pacchettiModal");
    const closePacchettiModal = document.getElementById("closePacchettiModal");
    const pacchettiList = document.getElementById("pacchettiAttiviList");

    if (openPacchettiBtn && pacchettiModal) {
        openPacchettiBtn.addEventListener("click", function() {

            pacchettiModal.style.display = "block";

            fetch("/api/pacchetti_dashboard")
                .then(res => {
                    if (!res.ok) throw new Error("Errore caricamento pacchetti attivi");
                    return res.json();
                })
                .then(data => {

                    pacchettiList.innerHTML = "";

                    if (!data.length) {
                        pacchettiList.innerHTML = "<div style='opacity:0.6;'>Nessun pacchetto attivo</div>";
                        return;
                    }

                    data.forEach(pac => {
                        const card = document.createElement("div");
                        card.className = "detail-card";
                        card.style.padding = "16px";
                        card.innerHTML = `
                            <div style="font-weight:600; font-size:15px;">${pac.cliente}</div>
                            <div style="margin-top:4px; font-size:13px; opacity:0.7;">
                                ${pac.nome_pacchetto}
                            </div>
                            <div style="margin-top:8px; font-size:13px;">
                                Sedute rimanenti: <strong>${pac.sedute_rimanenti}</strong>
                            </div>
                        `;
                        pacchettiList.appendChild(card);
                    });
                })
                .catch(error => {
                    console.error("Errore pacchetti dashboard:", error);
                    pacchettiList.innerHTML = "<div style='opacity:0.6;'>Errore caricamento dati</div>";
                    mostraToast("Errore nel caricamento pacchetti attivi", "error");
                });
        });
    }

    if (closePacchettiModal && pacchettiModal) {
        closePacchettiModal.addEventListener("click", function() {
            pacchettiModal.style.display = "none";
        });
    }

    if (mobileMode) {
        creaFabMobile();
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

async function aggiornaOrario(infoOrEvent) {
    const info = infoOrEvent && infoOrEvent.event
        ? infoOrEvent
        : { event: infoOrEvent, revert: null };
    const evento = info.event;

    if (!evento) return;

    const endISO = evento.end
        ? formatDateTimeForApi(evento.end)
        : formatDateTimeForApi(new Date(evento.start.getTime() + 60 * 60000));

    try {
        await fetchJsonOrThrow('/api/appuntamenti/' + evento.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start_datetime: formatDateTimeForApi(evento.start),
                end_datetime: endISO
            })
        }, "Errore aggiornamento orario appuntamento");

        // aggiorna solo l'evento senza ricaricare tutto il calendario
        const ev = calendar.getEventById(evento.id);
        if (ev) ev.setDates(evento.start, evento.end);
    } catch (error) {
        console.error("Errore aggiorna orario:", error);
        if (typeof info.revert === "function") {
            info.revert();
        }
        mostraToast(error.message || "Errore aggiornamento orario", "error");
    }
}


/* ===============================
   MODALE NUOVO APPUNTAMENTO
=================================*/

function apriModal() {
    clientiSelezionati = [];

    if (!selectedStart || !selectedEnd) {
        impostaSelezioneDaData(calcolaStartDefaultPerMobile());
    }

    const modal = document.getElementById("eventoModal");
    requestAnimationFrame(() => modal.style.display = "block");

    inizializzaRicercaClienti();
    aggiornaClientiSelezionati();
    sincronizzaCampiDataOraNuovoEvento();

    const searchInput = document.getElementById("searchCliente");
    if (searchInput) requestAnimationFrame(() => searchInput.focus());
}

function chiudiModal() {
    const m = document.getElementById("eventoModal");
    if (!m) return;
    requestAnimationFrame(() => m.style.display = "none");
}

async function salvaEvento() {

    const servizioId = document.getElementById("servizioSelect").value;
    const pacchettoId = document.getElementById("pacchettoSelect")?.value || null;
    const dataOrarioCustom = leggiDataOraDalModalNuovoEvento();
    const salvaBtn = document.getElementById("btnSalvaEvento");

    if (salvaBtn?.disabled) return;

    if (!dataOrarioCustom) {
        mostraToast("Inserisci data e orario validi", "warning");
        return;
    }

    const { startLocal, endLocal } = dataOrarioCustom;

    if (endLocal <= startLocal) {
        mostraToast("L'ora di fine deve essere successiva all'ora di inizio", "warning");
        return;
    }

    selectedStart = formatDateTimeForApi(startLocal);
    selectedEnd = formatDateTimeForApi(endLocal);

    if (clientiSelezionati.length === 0 || !servizioId) {
        mostraToast("Seleziona almeno un cliente e un servizio", "warning");
        return;
    }

    setButtonLoading(salvaBtn, true, { label: "Salvataggio..." });

    try {
        await fetchJsonOrThrow('/api/appuntamenti', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clienti_ids: clientiSelezionati.map(c => c.id),
                servizio_id: servizioId,
                pacchetto_cliente_id: pacchettoId,
                start_datetime: selectedStart,
                end_datetime: selectedEnd,
                note: "",
                durata_minuti: Math.round((new Date(selectedEnd) - new Date(selectedStart)) / 60000)
            })
        }, "Errore nel salvataggio appuntamento");

        chiudiModal();
        calendar.refetchEvents();
        clientiSelezionati = [];
        aggiornaClientiSelezionati();
        mostraToast("Appuntamento creato con successo.", "success");
    } catch (error) {
        console.error("Errore:", error);
        mostraToast(error.message || "Errore nel creare appuntamento", "error");
    } finally {
        setButtonLoading(salvaBtn, false);
    }
}


/* ===============================
   MODALE MODIFICA APPUNTAMENTO
=================================*/

function getColoreServizio(servizio) {
    const key = (servizio || "").toString().trim().toLowerCase();
    return SERVIZIO_COLORI[key] || "#111827";
}

function apriModificaModal() {

    const extended = window.eventoSelezionato.extendedProps || {};

    const clienti = extended.clienti || "";
    const clientiIds = extended.clienti_ids || [];
    const servizio = extended.servizio || "";
    const numeroSeduta = extended.numero_seduta;

    let titoloHTML = "";

    if (clienti) {

        // Se abbiamo array ID clienti (multi cliente)
        if (Array.isArray(clientiIds) && clientiIds.length > 0) {

            // Se i clienti arrivano come stringa tipo "Nome1 + Nome2" li separiamo
            let nomiArray = [];

            if (Array.isArray(clienti)) {
                nomiArray = clienti;
            } else if (typeof clienti === "string") {
                nomiArray = clienti.split("+").map(n => n.trim());
            }

            clientiIds.forEach((id, index) => {

                const nomeVisualizzato = nomiArray[index] || "Cliente";

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

    const data = formatDateForInput(start);
    const oraInizio = start.toTimeString().slice(0,5);
    const oraFine = end.toTimeString().slice(0,5);

    document.getElementById("dataModifica").value = data;
    document.getElementById("oraInizioModifica").value = oraInizio;
    document.getElementById("oraFineModifica").value = oraFine;


    const modal = document.getElementById("modificaModal");
    if (!modal) return;
    requestAnimationFrame(() => {
        modal.style.display = "block";
        modal.classList.add("modal-active");
    });

    // 🎯 Restyle bottone elimina PREMIUM (selezione sicura per classe)
    const deleteBtn = modal.querySelector(".btn-danger");
    if (deleteBtn) {

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
    requestAnimationFrame(() => modal.style.display = "none");
}


/* ===============================
   CHIUSURA MODALI (CLICK FUORI + ESC)
=================================*/

window.addEventListener("click", function(event) {

    const eventoModal = document.getElementById("eventoModal");
    const clienteModal = document.getElementById("clienteModal");
    const modificaModal = document.getElementById("modificaModal");
    const pacchettiModal = document.getElementById("pacchettiModal");

    if (eventoModal && event.target === eventoModal) {
        chiudiModal();
    }

    if (clienteModal && event.target === clienteModal) {
        chiudiModalCliente();
    }

    if (modificaModal && event.target === modificaModal) {
        chiudiModificaModal();
    }

    if (pacchettiModal && event.target === pacchettiModal) {
        pacchettiModal.style.display = "none";
    }
}, { passive: true });

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
}, { passive: true });

async function salvaModifiche() {

    const data = document.getElementById("dataModifica").value;
    const oraInizio = document.getElementById("oraInizioModifica").value;
    const oraFine = document.getElementById("oraFineModifica").value;
    const salvaBtn = document.getElementById("btnSalvaModifiche");

    if (salvaBtn?.disabled) return;
    if (!window.eventoSelezionato) {
        mostraToast("Nessun appuntamento selezionato", "error");
        return;
    }

    if (!data || !oraInizio || !oraFine) {
        mostraToast("Compila data e orari prima di salvare", "warning");
        return;
    }

    const start_datetime = data + "T" + oraInizio + ":00";
    const end_datetime = data + "T" + oraFine + ":00";

    if (end_datetime <= start_datetime) {
        mostraToast("L'ora di fine deve essere successiva all'ora di inizio", "warning");
        return;
    }

    setButtonLoading(salvaBtn, true, { label: "Salvataggio..." });

    try {
        await fetchJsonOrThrow('/api/appuntamenti/' + window.eventoSelezionato.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start_datetime: start_datetime,
                end_datetime: end_datetime
            })
        }, "Errore nel salvataggio modifiche");

        chiudiModificaModal();
        calendar.refetchEvents();
        mostraToast("Appuntamento aggiornato con successo.", "success");
    } catch (error) {
        console.error("Errore aggiorna appuntamento:", error);
        mostraToast(error.message || "Errore nel salvataggio modifiche", "error");
    } finally {
        setButtonLoading(salvaBtn, false);
    }
}


async function eliminaEvento() {

    if (!confirm("Sei sicuro di voler eliminare l'appuntamento?")) return;
    if (!window.eventoSelezionato) {
        mostraToast("Nessun appuntamento selezionato", "error");
        return;
    }

    const deleteBtn = document.getElementById("btnEliminaEvento");
    if (deleteBtn?.disabled) return;

    setButtonLoading(deleteBtn, true, { replaceContent: false });

    try {
        await fetchJsonOrThrow('/api/appuntamenti/' + window.eventoSelezionato.id, {
            method: 'DELETE'
        }, "Errore durante eliminazione appuntamento");

        chiudiModificaModal();
        calendar.refetchEvents();
        mostraToast("Appuntamento eliminato con successo.", "success");
    } catch (error) {
        console.error("Errore elimina appuntamento:", error);
        mostraToast(error.message || "Errore durante eliminazione", "error");
    } finally {
        setButtonLoading(deleteBtn, false, { replaceContent: false });
    }
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


function inviaPromemoriaWhatsApp() {

    if (!window.eventoSelezionato) {
        mostraToast("Nessun appuntamento selezionato", "error");
        return;
    }

    const extended = window.eventoSelezionato.extendedProps || {};
    const clientiIds = extended.clienti_ids || [];
    const servizio = extended.servizio || "trattamento";

    if (!clientiIds.length) {
        mostraToast("Cliente non disponibile", "error");
        return;
    }

    const clienteId = clientiIds[0];

    fetch('/api/clienti/' + clienteId)
        .then(res => {
            if (!res.ok) throw new Error("Errore recupero numero");
            return res.json();
        })
        .then(cliente => {

            if (!cliente.telefono) {
                mostraToast("Numero non disponibile", "error");
                return;
            }

            // 🔧 Normalizzazione numero (solo cifre)
            let numero = cliente.telefono
                .replace(/\s+/g, '')
                .replace(/-/g, '')
                .replace(/[^\d]/g, '');

            // Se numero italiano senza prefisso → aggiunge 39
            if (numero.length === 10 && numero.startsWith("3")) {
                numero = "39" + numero;
            }

            const start = window.eventoSelezionato.start;
            const data = start.toLocaleDateString('it-IT');
            const ora = start.toTimeString().slice(0,5);

            const messaggio = `Ciao ${cliente.nome}, ti ricordo l'appuntamento di ${servizio} il ${data} alle ${ora}. A presto!`;

            const url = `https://wa.me/${numero}?text=${encodeURIComponent(messaggio)}`;

            // 🔥 Apertura diretta (evita blocco popup)
            window.location.href = url;

            mostraToast("Apertura WhatsApp...", "success");
            autoClosePromemoria();
        })
        .catch(() => {
            mostraToast("Errore recupero numero", "error");
        });
}

function inviaPromemoriaMail() {
    mostraToast("Promemoria Email (UI pronta)", "success");
    autoClosePromemoria();
}

function inviaPromemoriaSMS() {
    mostraToast("Promemoria SMS (UI pronta)", "success");
    autoClosePromemoria();
}

function togglePromemoriaOptions() {

    const options = document.getElementById("promemoriaOptions");
    const mainBtn = document.getElementById("btnPromemoriaMain");

    if (!options || !mainBtn) return;

    const isHidden = options.classList.contains("promemoria-hidden");

    if (isHidden) {
        options.classList.remove("promemoria-hidden");
        options.classList.add("promemoria-visible");
        mainBtn.textContent = "Chiudi";
    } else {
        options.classList.remove("promemoria-visible");
        options.classList.add("promemoria-hidden");
        mainBtn.textContent = "Invia Promemoria";
    }
}

function autoClosePromemoria() {
    const options = document.getElementById("promemoriaOptions");
    const mainBtn = document.getElementById("btnPromemoriaMain");

    if (!options || !mainBtn) return;

    options.classList.remove("promemoria-visible");
    options.classList.add("promemoria-hidden");
    mainBtn.textContent = "Invia Promemoria";
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

    let debounceTimer;

    searchInput.oninput = function() {

        clearTimeout(debounceTimer);

        debounceTimer = setTimeout(() => {

            const valore = this.value.toLowerCase();
            risultatiDiv.innerHTML = "";

            if (valore.length < 1) {
                risultatiDiv.style.display = "none";
                return;
            }

            const filtrati = tuttiClienti.filter(c =>
                (c.nome || "").toLowerCase().includes(valore) ||
                (c.cognome || "").toLowerCase().includes(valore)
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

        }, 120);
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

async function salvaCliente() {
    const nome = document.getElementById("nomeCliente").value.trim();
    const cognome = document.getElementById("cognomeCliente").value.trim();
    const telefono = document.getElementById("telefonoCliente").value.trim();
    const email = document.getElementById("emailCliente").value.trim();
    const noteCliniche = document.getElementById("noteClinicheCliente").value;

    if (!nome || !cognome) {
        mostraToast("Nome e cognome sono obbligatori", "warning");
        return;
    }

    const salvaBtn = document.querySelector("#clienteModal .btn-apple-primary");
    if (salvaBtn?.disabled) return;

    setButtonLoading(salvaBtn, true, { label: "Salvataggio..." });

    try {
        await fetchJsonOrThrow("/api/clienti", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                nome,
                cognome,
                telefono,
                email,
                note_cliniche: noteCliniche
            })
        }, "Errore creazione cliente");

        mostraToast("Cliente creato con successo.", "success");
        chiudiModalCliente();
        setTimeout(() => location.reload(), 250);
    } catch (error) {
        console.error("Errore creazione cliente:", error);
        mostraToast(error.message || "Errore creazione cliente", "error");
    } finally {
        setButtonLoading(salvaBtn, false);
    }
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
            const filtroServizio = document.getElementById("filtroServizio");
            if (select) select.innerHTML = "";
            if (filtroServizio) {
                filtroServizio.innerHTML = '<option value="">Tutti i servizi</option>';
            }

            data.forEach(servizio => {
                let option = document.createElement("option");
                option.value = servizio.id;
                option.text = servizio.nome;
                if (select) {
                    select.appendChild(option);
                }

                if (filtroServizio) {
                    const filterOption = document.createElement("option");
                    filterOption.value = servizio.id;
                    filterOption.text = servizio.nome;
                    filtroServizio.appendChild(filterOption);
                }
            });
        });
}

/* ===============================
   TOAST NOTIFICHE (SaaS Mode)
=================================*/

function mostraToast(messaggio, tipo = "success") {
    const icone = {
        success: "✔",
        error: "✖",
        warning: "!",
        info: "i"
    };
    const icona = icone[tipo] || "•";

    let container = document.getElementById("appToastContainer");
    if (!container) {
        container = document.createElement("div");
        container.id = "appToastContainer";
        container.className = "app-toast-container";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = `app-toast app-toast-${tipo}`;
    toast.innerHTML = `
        <div class="app-toast-content">
            <span class="app-toast-icon">${icona}</span>
            <span class="app-toast-message">${messaggio}</span>
        </div>
        <div class="app-toast-progress"></div>
    `;

    container.appendChild(toast);
    while (container.children.length > 3) {
        container.removeChild(container.firstElementChild);
    }

    requestAnimationFrame(() => toast.classList.add("app-toast-show"));

    setTimeout(() => {
        toast.classList.remove("app-toast-show");
        toast.classList.add("app-toast-hide");
        setTimeout(() => toast.remove(), 260);
    }, 2500);
}

// =========================
// Toggle Storico Appuntamenti
// =========================

function toggleStorico() {
    const section = document.getElementById("storicoSection");
    const btn = document.querySelector(".storico-toggle-btn");

    if (!section || !btn) return;

    const isCollapsed = section.classList.contains("storico-collapsed");

    if (isCollapsed) {
        section.classList.remove("storico-collapsed");
        section.classList.remove("storico-fade");

        // forza repaint per riattivare animazione
        void section.offsetWidth;

        section.classList.add("storico-fade");
        btn.textContent = "Nascondi storico";
    } else {
        section.classList.remove("storico-fade");
        section.classList.add("storico-collapsed");
        btn.textContent = "Mostra storico";
    }
}
