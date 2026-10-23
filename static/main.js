window.eventoSelezionato = null;
let calendar;
let selectedStart;
let selectedEnd;
let serviziData = [];
let tipiPacchettoData = [];
let tuttiClienti = [];
let clientiSelezionati = [];
let emailNuovoEvento = new Map();
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
let richiestaContatorePacchetti = 0;
let calendarReadSequence = 0;
let calendarReadState = 'ready';
let calendarPreviewToken = 0;
let calendarPreviewTimer;
let calendarPreviewAnchor;
let calendarWeekSequence = 0;

async function fetchCalendarWeekEvents(baseDate) {
    const { monday, sundayExclusive } = getSettimanaRange(baseDate);
    const events = await fetchJsonOrThrow(buildAppuntamentiUrl({
        startStr: formatDateTimeForApi(monday), endStr: formatDateTimeForApi(sundayExclusive)
    }), { cache: 'no-store' });
    if (!Array.isArray(events)) throw new Error('Elenco settimanale non disponibile');
    return events;
}

async function updateCalendarWeekSummary() {
    const sequence = ++calendarWeekSequence;
    const { monday, sundayExclusive } = getSettimanaRange(calendar.getDate());
    const options = { day: '2-digit', month: 'short' };
    const sunday = new Date(sundayExclusive); sunday.setDate(sunday.getDate() - 1);
    const label = document.getElementById('weekRangeLabel');
    const counter = document.getElementById('weekCount');
    if (label) label.textContent = `${monday.toLocaleDateString('it-IT', options)} – ${sunday.toLocaleDateString('it-IT', options)}`;
    if (counter) counter.textContent = '…';
    try {
        const events = await fetchCalendarWeekEvents(calendar.getDate());
        if (sequence === calendarWeekSequence && counter) counter.textContent = String(events.length);
    } catch (_) {
        if (sequence === calendarWeekSequence && counter) counter.textContent = '—';
    }
}

const CALENDAR_STATES = Object.freeze({
    prenotato: 'Prenotato', confermato: 'Confermato', svolto: '✓ Svolto',
    completato: '✓ Completato', annullato: '↪ Annullato', no_show: '! Assente', occupato: 'Occupato'
});

function calendarSessionLabel(props) {
    if (!props.numero_seduta || props.occupato) return '';
    return `Seduta ${props.numero_seduta}${props.sedute_totali ? `/${props.sedute_totali}` : ''}`;
}

function calendarTimeLabel(event) {
    return event.start ? `${formatTimeHm(event.start)}${event.end ? ` – ${formatTimeHm(event.end)}` : ''}` : '';
}

function calendarTextElement(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = text;
    return element;
}

function renderCalendarEvent(arg) {
    if (arg.event.display === 'background') return;
    const props = arg.event.extendedProps || {};
    const wrapper = calendarTextElement('div', 'calendar-event-content', '');
    wrapper.appendChild(calendarTextElement('div', 'calendar-event-time', calendarTimeLabel(arg.event)));
    wrapper.appendChild(calendarTextElement('div', 'calendar-event-name', arg.isMirror ? 'Nuovo appuntamento'
        : props.occupato ? 'Occupato' : props.clienti || arg.event.title || 'Appuntamento'));
    if (arg.isMirror || props.occupato) return { domNodes: [wrapper] };
    if (props.servizio) wrapper.appendChild(calendarTextElement('div', 'calendar-event-service', props.servizio));
    const meta = calendarTextElement('div', 'calendar-event-meta', '');
    const session = calendarSessionLabel(props);
    if (session) meta.appendChild(calendarTextElement('span', 'calendar-session-badge', session));
    if (props.stato && props.stato !== 'prenotato') {
        meta.appendChild(calendarTextElement('span', 'calendar-state-badge', CALENDAR_STATES[props.stato] || props.stato));
    }
    // This flag is a manual reminder marker, not proof of WhatsApp delivery.
    if (props.reminder_whatsapp) meta.appendChild(calendarTextElement('span', 'calendar-reminder-badge', '✓ WA'));
    wrapper.appendChild(meta);
    return { domNodes: [wrapper] };
}

function hideCalendarPreview() {
    clearTimeout(calendarPreviewTimer);
    calendarPreviewToken++;
    const preview = document.getElementById('calendarPreview');
    if (preview) preview.hidden = true;
    if (calendarPreviewAnchor) calendarPreviewAnchor.removeAttribute('aria-describedby');
    calendarPreviewAnchor = null;
}

function scheduleHideCalendarPreview() {
    clearTimeout(calendarPreviewTimer);
    calendarPreviewTimer = setTimeout(hideCalendarPreview, 160);
}

function positionCalendarPreview(preview, anchor) {
    const rect = anchor.getBoundingClientRect();
    preview.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - preview.offsetWidth - 8))}px`;
    const below = rect.bottom + 8;
    preview.style.top = `${Math.max(8, below + preview.offsetHeight <= window.innerHeight ? below : rect.top - preview.offsetHeight - 8)}px`;
}

async function showCalendarPreview(info) {
    if (isMobileViewport() || info.isMirror || info.event.display === 'background') return;
    hideCalendarPreview();
    const token = calendarPreviewToken;
    let preview = document.getElementById('calendarPreview');
    if (!preview) {
        preview = document.createElement('div');
        preview.id = 'calendarPreview';
        preview.className = 'calendar-preview';
        preview.setAttribute('role', 'tooltip');
        preview.addEventListener('mouseenter', () => clearTimeout(calendarPreviewTimer));
        preview.addEventListener('mouseleave', scheduleHideCalendarPreview);
        document.body.appendChild(preview);
    }
    const props = info.event.extendedProps || {};
    const duration = info.event.end && info.event.start ? Math.round((info.event.end - info.event.start) / 60000) : null;
    const lines = [
        calendarTextElement('strong', 'calendar-preview-name', props.occupato ? 'Occupato' : props.clienti || info.event.title),
        calendarTextElement('div', '', `${info.event.start ? formatDateLabel(info.event.start) : ''} · ${calendarTimeLabel(info.event)}${duration ? ` · ${duration} min` : ''}`),
        calendarTextElement('div', '', props.occupato ? 'Slot non disponibile' : props.servizio || ''),
        calendarTextElement('div', '', [calendarSessionLabel(props), CALENDAR_STATES[props.stato]].filter(Boolean).join(' · '))
    ];
    const email = calendarTextElement('div', 'calendar-preview-email', 'Verifica conferme email…');
    if (!props.occupato) lines.push(email);
    preview.replaceChildren(...lines);
    preview.hidden = false;
    calendarPreviewAnchor = info.el;
    info.el.setAttribute('aria-describedby', 'calendarPreview');
    positionCalendarPreview(preview, info.el);
    if (props.occupato) return;
    try {
        const result = await fetchJsonOrThrow(`/api/appuntamenti/${encodeURIComponent(info.event.id)}/conferme`, { cache: 'no-store' });
        if (token !== calendarPreviewToken) return;
        const labels = { sent: 'Inviata (consegna non verificata)', sending: 'Invio in corso', unknown: 'Esito incerto',
            outdated: 'Da aggiornare', failed: 'Invio non riuscito', untracked: 'Non inviata' };
        email.textContent = (result.destinatari || []).map(person => `${person.nome}: ${!person.has_email ? 'Indirizzo mancante'
            : labels[person.status] || 'Stato non disponibile'}`).join(' · ') || 'Nessun destinatario email';
        positionCalendarPreview(preview, info.el);
    } catch (_) {
        if (token === calendarPreviewToken) email.textContent = 'Stato email non disponibile';
    }
}

function mountCalendarEvent(info) {
    if (info.event.display === 'background') return;
    const props = info.event.extendedProps || {};
    const color = props.occupato ? '#b91c1c' : /^#[\da-f]{6}$/i.test(info.event.backgroundColor || '')
        ? info.event.backgroundColor : getColoreServizio(props.servizio || '');
    info.el.style.setProperty('--calendar-event-accent', color);
    info.el.classList.add('calendar-appointment');
    if (info.isMirror) info.el.classList.add('is-preview');
    if (props.occupato) info.el.classList.add('is-busy');
    if (props.stato === 'annullato') info.el.classList.add('is-cancelled');
    if (props.stato === 'no_show') info.el.classList.add('is-no-show');
    info.el.setAttribute('aria-label', [calendarTimeLabel(info.event), props.occupato ? 'Occupato' : props.clienti,
        props.servizio, calendarSessionLabel(props), CALENDAR_STATES[props.stato]].filter(Boolean).join(', '));
    if (info.isMirror) return;
    info.el.setAttribute('tabindex', '0');
    info.el.setAttribute('role', 'button');
    info.el.addEventListener('focus', () => showCalendarPreview(info));
    info.el.addEventListener('blur', scheduleHideCalendarPreview);
    info.el.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCalendarAppointment(info);
        }
    });
    const compact = () => {
        const height = info.el.getBoundingClientRect().height;
        info.el.classList.toggle('is-tight', height < 100);
        info.el.classList.toggle('is-short', height < 70);
        info.el.classList.toggle('is-tiny', height < 44);
    };
    compact();
    if (typeof ResizeObserver !== 'undefined') {
        info.el.calendarObserver = new ResizeObserver(compact);
        info.el.calendarObserver.observe(info.el);
    }
}

function openCalendarAppointment(info) {
    info.jsEvent?.preventDefault?.();
    hideCalendarPreview();
    window.eventoSelezionato = info.event;
    apriModificaModal();
}

function setCalendarReadState(state, message = '') {
    calendarReadState = state;
    const text = document.getElementById('calendarStatusText');
    const retry = document.getElementById('calendarRetry');
    const element = document.getElementById('calendar');
    if (text) text.textContent = message;
    if (retry) retry.hidden = state !== 'error';
    if (element) {
        element.setAttribute('aria-busy', String(state === 'loading'));
        // Failed reads must never look like free, bookable time.
        element.classList.toggle('calendar-unavailable', state === 'error');
    }
    for (const id of ['calendarNew', 'mobileAddFab']) {
        const button = document.getElementById(id);
        if (button) { button.disabled = state !== 'ready'; button.title = state === 'ready' ? 'Nuovo appuntamento' : 'Attendi il caricamento dell’agenda'; }
    }
}

async function loadCalendarEvents(fetchInfo, successCallback, failureCallback) {
    const sequence = ++calendarReadSequence;
    setCalendarReadState('loading', 'Aggiornamento agenda…');
    try {
        const events = await fetchJsonOrThrow(buildAppuntamentiUrl(fetchInfo), { cache: 'no-store' });
        if (!Array.isArray(events)) throw new Error('Risposta calendario non valida');
        if (sequence === calendarReadSequence) {
            setCalendarReadState('ready', events.length ? '' : 'Nessun appuntamento nel periodo con i filtri selezionati.');
        }
        successCallback(events);
    } catch (_) {
        if (sequence === calendarReadSequence) setCalendarReadState('error', 'Agenda non aggiornata. La disponibilità non è verificata.');
        failureCallback(new Error('Impossibile caricare il calendario'));
    }
}

function updateCalendarToolbar(info) {
    hideCalendarPreview();
    const title = document.getElementById('calendarTitle');
    const date = document.getElementById('calendarDate');
    if (title) title.textContent = info.view.title;
    if (date) date.value = formatDateForInput(info.view.calendar.getDate());
    for (const [id, type] of [['calendarViewDay', 'timeGridDay'], ['calendarViewWeek', 'timeGridWeek']]) {
        document.getElementById(id)?.setAttribute('aria-pressed', String(info.view.type === type));
    }
}

function initializeCalendarControls() {
    const actions = {
        calendarPrev: () => calendar.prev(), calendarNext: () => calendar.next(), calendarToday: () => calendar.today(),
        calendarViewDay: () => calendar.changeView('timeGridDay'), calendarViewWeek: () => calendar.changeView('timeGridWeek'),
        calendarRetry: () => calendar.refetchEvents(),
        calendarNew: () => { if (calendarReadState !== 'ready') return; impostaSelezioneDaData(calcolaStartDefaultPerMobile()); apriModal(); }
    };
    for (const [id, action] of Object.entries(actions)) document.getElementById(id)?.addEventListener('click', action);
    document.getElementById('calendarDate')?.addEventListener('change', event => {
        if (event.target.value && event.target.validity.valid) calendar.gotoDate(event.target.value);
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideCalendarPreview(); });
    window.addEventListener('scroll', hideCalendarPreview, true);
    window.addEventListener('resize', hideCalendarPreview);
}

function renderCalendarFilterChips() {
    const container = document.getElementById('calendarActiveFilters');
    if (!container) return;
    container.replaceChildren();
    const fields = { stato: ['Stato', 'filtroStato'], servizio_id: ['Servizio', 'filtroServizio'],
        cliente: ['Cliente', 'filtroCliente'], data_da: ['Dal', 'filtroDataDa'], data_a: ['Al', 'filtroDataA'] };
    for (const [key, [label, id]] of Object.entries(fields)) {
        const value = filtriCalendario[key];
        if (!value) continue;
        const input = document.getElementById(id);
        const displayed = key === 'stato' ? CALENDAR_STATES[value] || value
            : key === 'servizio_id' ? input?.selectedOptions?.[0]?.textContent || value
            : key.startsWith('data_') ? value.split('-').reverse().join('/') : value;
        const button = calendarTextElement('button', 'calendar-filter-chip', `${label}: ${displayed} ×`);
        button.type = 'button';
        button.setAttribute('aria-label', `Rimuovi filtro ${label}: ${displayed}`);
        button.addEventListener('click', () => {
            clearTimeout(filtroClienteDebounceTimer);
            if (input) input.value = '';
            aggiornaFiltriCalendarioDaUI(true);
            document.getElementById('toggleFiltriCalendario')?.focus();
        });
        container.appendChild(button);
    }
    const count = document.getElementById('calendarFilterCount');
    if (count) { count.hidden = !container.children.length; count.textContent = String(container.children.length); }
}

async function aggiornaContatorePacchetti() {
    const counter = document.getElementById('dashboardPacchettiCount');
    if (!counter) return;
    const richiesta = ++richiestaContatorePacchetti;
    try {
        const packages = await fetchJsonOrThrow('/api/pacchetti_dashboard', {}, 'Impossibile aggiornare i pacchetti');
        if (richiesta === richiestaContatorePacchetti && Array.isArray(packages)) counter.textContent = String(packages.length);
    } catch (_) { /* Preserve the last known count; the package panel reports read errors. */ }
}

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
    fab.disabled = calendarReadState !== 'ready';

    fab.addEventListener("click", function() {
        if (calendarReadState !== 'ready') return;
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

function sincronizzaRicorrenzaEventoUI() {
    const repeatCheckbox = document.getElementById("eventoRipetiSettimanale");
    const occurrencesInput = document.getElementById("eventoNumeroOccorrenze");
    if (!repeatCheckbox || !occurrencesInput) return;

    const isRecurring = !!repeatCheckbox.checked;
    occurrencesInput.disabled = !isRecurring;
    if (!isRecurring) {
        occurrencesInput.value = "2";
    }

    const slotAddBtn = document.getElementById("btnAggiungiSlotPersonalizzato");
    if (slotAddBtn) {
        slotAddBtn.disabled = isRecurring;
    }

    document
        .querySelectorAll("#eventoSlotPersonalizzatiList input, #eventoSlotPersonalizzatiList button")
        .forEach(el => {
            el.disabled = isRecurring;
        });
    aggiornaRiepilogoNuovoEvento();
}

function inizializzaRicorrenzaEvento() {
    const repeatCheckbox = document.getElementById("eventoRipetiSettimanale");
    const occurrencesInput = document.getElementById("eventoNumeroOccorrenze");

    if (!repeatCheckbox || !occurrencesInput || repeatCheckbox.dataset.bound === "1") return;

    repeatCheckbox.dataset.bound = "1";
    repeatCheckbox.addEventListener("change", sincronizzaRicorrenzaEventoUI);

    occurrencesInput.addEventListener("input", () => {
        const parsed = Number.parseInt(occurrencesInput.value, 10);
        if (!Number.isFinite(parsed)) return;
        if (parsed < 2) occurrencesInput.value = "2";
        if (parsed > 52) occurrencesInput.value = "52";
    });

    sincronizzaRicorrenzaEventoUI();
}

function resetRicorrenzaEvento() {
    const repeatCheckbox = document.getElementById("eventoRipetiSettimanale");
    const occurrencesInput = document.getElementById("eventoNumeroOccorrenze");
    if (!repeatCheckbox || !occurrencesInput) return;

    repeatCheckbox.checked = false;
    occurrencesInput.value = "2";
    sincronizzaRicorrenzaEventoUI();
}

function sincronizzaStatoOccupatoUI() {
    const occupatoCheckbox = document.getElementById("eventoOccupato");
    const clienteSection = document.getElementById("eventoClienteSection");
    const pacchettoSection = document.getElementById("eventoPacchettoSection");
    const emailConfermaSection = document.getElementById("eventoEmailConfermaSection");
    const salvaBtn = document.getElementById("btnSalvaEvento");
    if (!occupatoCheckbox) return;

    const isOccupato = occupatoCheckbox.checked;
    if (clienteSection) clienteSection.hidden = isOccupato;
    if (pacchettoSection) pacchettoSection.hidden = isOccupato;
    if (emailConfermaSection) emailConfermaSection.hidden = isOccupato;
    if (salvaBtn) salvaBtn.textContent = isOccupato ? "Occupa Slot" : "Salva Appuntamento";
    aggiornaRiepilogoNuovoEvento();
}

function inizializzaStatoOccupato() {
    const occupatoCheckbox = document.getElementById("eventoOccupato");
    if (!occupatoCheckbox || occupatoCheckbox.dataset.bound === "1") return;

    occupatoCheckbox.dataset.bound = "1";
    occupatoCheckbox.addEventListener("change", sincronizzaStatoOccupatoUI);
    sincronizzaStatoOccupatoUI();
}

function resetStatoOccupato() {
    const occupatoCheckbox = document.getElementById("eventoOccupato");
    const emailConfermaCheckbox = document.getElementById("eventoInviaConfermaEmail");
    if (!occupatoCheckbox) return;

    occupatoCheckbox.checked = false;
    if (emailConfermaCheckbox) emailConfermaCheckbox.checked = false;
    sincronizzaStatoOccupatoUI();
}

function creaRigaSlotPersonalizzato(slot = null) {
    const row = document.createElement("div");
    row.className = "event-custom-slot-row";

    const inputData = document.createElement("input");
    inputData.type = "date";
    inputData.className = "input-apple event-custom-slot-date";
    inputData.setAttribute("aria-label", "Data aggiuntiva");

    const inputOraInizio = document.createElement("input");
    inputOraInizio.type = "time";
    inputOraInizio.step = "900";
    inputOraInizio.className = "input-apple event-custom-slot-start";
    inputOraInizio.setAttribute("aria-label", "Ora di inizio aggiuntiva");

    const inputOraFine = document.createElement("input");
    inputOraFine.type = "time";
    inputOraFine.step = "900";
    inputOraFine.className = "input-apple event-custom-slot-end";
    inputOraFine.setAttribute("aria-label", "Ora di fine aggiuntiva");

    if (slot?.startLocal instanceof Date && !Number.isNaN(slot.startLocal.getTime())) {
        inputData.value = formatDateForInput(slot.startLocal);
        inputOraInizio.value = formatTimeForInput(slot.startLocal);
    }

    if (slot?.endLocal instanceof Date && !Number.isNaN(slot.endLocal.getTime())) {
        inputOraFine.value = formatTimeForInput(slot.endLocal);
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "event-custom-slot-remove";
    removeBtn.setAttribute("aria-label", "Rimuovi slot");
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => {
        row.remove();
        aggiornaRiepilogoNuovoEvento();
    });

    row.appendChild(inputData);
    row.appendChild(inputOraInizio);
    row.appendChild(inputOraFine);
    row.appendChild(removeBtn);

    return row;
}

function aggiungiSlotPersonalizzato(slot = null) {
    const list = document.getElementById("eventoSlotPersonalizzatiList");
    if (!list) return;

    if (list.children.length >= 40) {
        mostraToast("Puoi aggiungere al massimo 40 slot personalizzati", "info");
        return;
    }

    list.appendChild(creaRigaSlotPersonalizzato(slot));

    const repeatCheckbox = document.getElementById("eventoRipetiSettimanale");
    if (repeatCheckbox?.checked) {
        repeatCheckbox.checked = false;
    }
    sincronizzaRicorrenzaEventoUI();
}

function inizializzaSlotPersonalizzati() {
    const addBtn = document.getElementById("btnAggiungiSlotPersonalizzato");
    if (!addBtn || addBtn.dataset.bound === "1") return;

    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", () => aggiungiSlotPersonalizzato());
}

function resetSlotPersonalizzati() {
    const list = document.getElementById("eventoSlotPersonalizzatiList");
    if (!list) return;
    list.innerHTML = "";
}

function leggiSlotPersonalizzatiDalModal() {
    const rows = Array.from(document.querySelectorAll("#eventoSlotPersonalizzatiList .event-custom-slot-row"));
    const slots = [];

    for (const row of rows) {
        const data = row.querySelector(".event-custom-slot-date")?.value || "";
        const oraInizio = row.querySelector(".event-custom-slot-start")?.value || "";
        const oraFine = row.querySelector(".event-custom-slot-end")?.value || "";

        const rowVuota = !data && !oraInizio && !oraFine;
        if (rowVuota) continue;

        if (!data || !oraInizio || !oraFine) {
            return {
                error: "Compila data, ora inizio e ora fine per ogni slot aggiuntivo."
            };
        }

        const startLocal = new Date(`${data}T${oraInizio}:00`);
        const endLocal = new Date(`${data}T${oraFine}:00`);

        if (Number.isNaN(startLocal.getTime()) || Number.isNaN(endLocal.getTime())) {
            return {
                error: "Formato data/orario non valido negli slot personalizzati."
            };
        }

        if (endLocal <= startLocal) {
            return {
                error: "Negli slot personalizzati, l'ora fine deve essere successiva all'inizio."
            };
        }

        slots.push({ startLocal, endLocal });
    }

    return { slots };
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

function buildAppuntamentiUrl(fetchInfo, options = {}) {
    const { includeFilters = true } = options;
    const params = new URLSearchParams({
        start: fetchInfo.startStr,
        end: fetchInfo.endStr
    });

    if (includeFilters) {
        if (filtriCalendario.stato) params.set("stato", filtriCalendario.stato);
        if (filtriCalendario.servizio_id) params.set("servizio_id", filtriCalendario.servizio_id);
        if (filtriCalendario.cliente) params.set("cliente", filtriCalendario.cliente);
        if (filtriCalendario.data_da) params.set("data_da", filtriCalendario.data_da);
        if (filtriCalendario.data_a) params.set("data_a", filtriCalendario.data_a);
    }

    return `/api/appuntamenti?${params.toString()}`;
}

function getSettimanaRange(baseDate) {
    const day = baseDate.getDay();
    const diffToMonday = (day === 0 ? -6 : 1) - day;
    const monday = new Date(baseDate);
    monday.setDate(baseDate.getDate() + diffToMonday);
    monday.setHours(0, 0, 0, 0);
    // Calendar days, not fixed 24-hour periods: Rome changes DST on Sundays.
    const sundayExclusive = new Date(monday);
    sundayExclusive.setDate(monday.getDate() + 7);
    return { monday, sundayExclusive };
}

function formatTimeHm(date) {
    return date.toLocaleTimeString("it-IT", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
    });
}

function formatDateLabel(date) {
    return date.toLocaleDateString("it-IT", {
        weekday: "short",
        day: "2-digit",
        month: "short"
    });
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
    renderCalendarFilterChips();

    if (refetch && calendar) {
        calendar.refetchEvents();
    }
}

function resetFiltriCalendario() {
    clearTimeout(filtroClienteDebounceTimer);
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
    renderCalendarFilterChips();
    if (calendar) calendar.refetchEvents();
}

function inizializzaFiltriCalendario() {
    const filtroStato = document.getElementById("filtroStato");
    const filtroServizio = document.getElementById("filtroServizio");
    const filtroCliente = document.getElementById("filtroCliente");
    const filtroDataDa = document.getElementById("filtroDataDa");
    const filtroDataA = document.getElementById("filtroDataA");
    const resetBtn = document.getElementById("resetFiltriCalendario");
    const toggleBtn = document.getElementById("toggleFiltriCalendario");
    const filtersPanel = document.getElementById("calendarFiltersPanel");
    const filtersCard = document.querySelector(".calendar-filters-card");

    if (!filtroStato || !filtroServizio || !filtroCliente || !filtroDataDa || !filtroDataA || !resetBtn || !toggleBtn || !filtersPanel || !filtersCard) {
        return;
    }

    toggleBtn.addEventListener("click", () => {
        const isOpening = filtersPanel.hidden;
        filtersPanel.hidden = !isOpening;
        filtersCard.classList.toggle("is-open", isOpening);
        toggleBtn.setAttribute("aria-expanded", String(isOpening));
        toggleBtn.setAttribute("aria-label", isOpening ? "Chiudi filtri calendario" : "Apri filtri calendario");
        toggleBtn.title = isOpening ? "Chiudi filtri" : "Cerca e filtra";

        if (isOpening) {
            filtroCliente.focus();
        }
    });

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
        firstDay: 1,
        headerToolbar: false,

buttonText: {
    today: 'Oggi',
    week: 'Settimana',
    day: 'Giorno'
},
        dayHeaderFormat: mobileMode
            ? { weekday: 'short', day: '2-digit', month: '2-digit' }
            : { weekday: 'short', day: 'numeric', month: 'numeric' },
        height: '100%',
        expandRows: false,
        nowIndicator: true,
        stickyHeaderDates: true,
        lazyFetching: true,
        progressiveEventRendering: true,
        rerenderDelay: 50,
        initialDate: new Date(),
        locale: 'it',
        allDayText: 'Tutto il giorno',
        selectable: !mobileMode,
        selectMirror: true, // mostra anteprima evento mentre trascini (stile Apple Calendar)
        editable: !mobileMode,
        eventStartEditable: !mobileMode,
        eventDurationEditable: !mobileMode,
        eventAllow: () => calendarReadState === 'ready',
        windowResize: function() {
            const mobile = isMobileViewport();
            document.body.classList.toggle('mobile-calendar-mode', mobile);
            for (const option of ['editable', 'eventStartEditable', 'eventDurationEditable', 'selectable']) calendar.setOption(option, !mobile);
            if (mobile) creaFabMobile();
        },
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

        events: loadCalendarEvents,

        // Preview visivo mentre trascini per creare appuntamento
        selectAllow: () => calendarReadState === 'ready',

        select: function(info) {
            if (calendarReadState !== 'ready') return;
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
            if (!isMobileViewport() || calendarReadState !== 'ready') return;
            impostaSelezioneDaData(info.date);
            apriModal();
        },

        eventClick: openCalendarAppointment,

        eventDrop: info => aggiornaOrario(info),
        eventResize: info => aggiornaOrario(info),
        eventDragStart: hideCalendarPreview,
        eventResizeStart: hideCalendarPreview,

        displayEventTime: false,
        eventContent: renderCalendarEvent,
        eventDidMount: mountCalendarEvent,
        eventMouseEnter: showCalendarPreview,
        eventMouseLeave: scheduleHideCalendarPreview,
        eventWillUnmount: info => {
            info.el.calendarObserver?.disconnect();
            if (calendarPreviewAnchor === info.el) hideCalendarPreview();
        },
        datesSet: updateCalendarToolbar,
    });

    calendar.render();
    initializeCalendarControls();
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

    calendar.on('eventsSet', updateCalendarWeekSummary);
    calendar.on('eventsSet', aggiornaContatorePacchetti);
    calendar.on('datesSet', updateCalendarWeekSummary);
    updateCalendarWeekSummary();

    // ===============================
    // AUTO OPEN EVENT FROM URL (?open_event=ID)
    // ===============================

    const params = new URLSearchParams(window.location.search);
    const openEventId = params.get("open_event");

    if (openEventId) {
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
    }

    caricaClienti(); // ora carica array per ricerca
    caricaServizi();
    caricaTipiPacchetto();
    inizializzaAssegnaPacchettoRapido();
    inizializzaRicorrenzaEvento();
    inizializzaSlotPersonalizzati();
    inizializzaStatoOccupato();
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
                        const nome = document.createElement("strong"); nome.textContent = pac.cliente;
                        const tipo = document.createElement("p"); tipo.className = "edit-help"; tipo.textContent = pac.nome_pacchetto;
                        const restanti = document.createElement("span"); restanti.className = Number(pac.sedute_rimanenti) <= 2 ? "package-low" : "package-remaining";
                        restanti.textContent = `Sedute rimanenti: ${pac.sedute_rimanenti}${Number(pac.sedute_rimanenti) <= 2 ? " · In esaurimento" : ""}`;
                        card.append(nome, tipo, restanti);
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

    // ===============================
    // MODAL APPUNTAMENTI DASHBOARD
    // ===============================

    const openAppuntamentiOggiBtn = document.getElementById("openAppuntamentiOggi");
    const openAppuntamentiSettimanaBtn = document.getElementById("openAppuntamentiSettimana");
    const dashboardAppModal = document.getElementById("dashboardAppModal");
    const closeDashboardAppModalBtn = document.getElementById("closeDashboardAppModal");
    const dashboardAppModalTitle = document.getElementById("dashboardAppModalTitle");
    const dashboardAppModalSubtitle = document.getElementById("dashboardAppModalSubtitle");
    const dashboardAppList = document.getElementById("dashboardAppList");
    let dashboardListSequence = 0;

    const statoLabelMap = {
        prenotato: "Prenotato",
        svolto: "Svolto",
        completato: "Completato",
        annullato: "Annullato",
        no_show: "No Show"
    };

    function normalizzaEventoDashboard(rawEvent) {
        const startValue = rawEvent?.start instanceof Date ? rawEvent.start : new Date(rawEvent?.start);
        if (!(startValue instanceof Date) || Number.isNaN(startValue.getTime())) return null;

        let endValue = null;
        if (rawEvent?.end) {
            endValue = rawEvent.end instanceof Date ? rawEvent.end : new Date(rawEvent.end);
            if (Number.isNaN(endValue.getTime())) endValue = null;
        }

        const extended = rawEvent?.extendedProps || {};
        const clienti = (extended.clienti || "").trim() || "Cliente non specificato";

        return {
            id: rawEvent.id,
            start: startValue,
            end: endValue,
            clienti: clienti,
            servizio: (extended.servizio || rawEvent.title || "Servizio").trim(),
            stato: (extended.stato || "").trim()
        };
    }

    function renderDashboardListaAppuntamenti(appuntamenti, emptyMessage) {
        if (!dashboardAppList) return;

        dashboardAppList.innerHTML = "";

        if (!appuntamenti.length) {
            const emptyState = document.createElement("div");
            emptyState.className = "dashboard-app-empty";
            emptyState.textContent = emptyMessage;
            dashboardAppList.appendChild(emptyState);
            return;
        }

        appuntamenti.forEach(app => {
            const item = document.createElement("article");
            item.className = "dashboard-app-item";

            const topRow = document.createElement("div");
            topRow.className = "dashboard-app-top";

            const dateEl = document.createElement("span");
            dateEl.className = "dashboard-app-date";
            dateEl.textContent = formatDateLabel(app.start);

            const timeEl = document.createElement("span");
            timeEl.className = "dashboard-app-time";
            if (app.end) {
                timeEl.textContent = `${formatTimeHm(app.start)} - ${formatTimeHm(app.end)}`;
            } else {
                timeEl.textContent = formatTimeHm(app.start);
            }

            topRow.appendChild(dateEl);
            topRow.appendChild(timeEl);

            const clienteEl = document.createElement("div");
            clienteEl.className = "dashboard-app-clienti";
            clienteEl.textContent = app.clienti;

            const bottomRow = document.createElement("div");
            bottomRow.className = "dashboard-app-bottom";

            const servizioEl = document.createElement("div");
            servizioEl.className = "dashboard-app-servizio";
            servizioEl.textContent = app.servizio;

            bottomRow.appendChild(servizioEl);

            if (app.stato) {
                const statoEl = document.createElement("span");
                statoEl.className = "dashboard-app-stato";
                statoEl.textContent = statoLabelMap[app.stato] || app.stato;
                bottomRow.appendChild(statoEl);
            }

            item.appendChild(topRow);
            item.appendChild(clienteEl);
            item.appendChild(bottomRow);
            dashboardAppList.appendChild(item);
        });
    }

    function apriDashboardAppModal({ title, subtitle }) {
        if (!dashboardAppModal || !dashboardAppModalTitle || !dashboardAppModalSubtitle || !dashboardAppList) return;
        dashboardAppModalTitle.textContent = title;
        dashboardAppModalSubtitle.textContent = subtitle;
        dashboardAppList.innerHTML = '<div class="dashboard-app-loading">Caricamento appuntamenti...</div>';
        dashboardAppModal.style.display = "block";
    }

    async function apriDashboardAppuntamentiOggi() {
        const sequence = ++dashboardListSequence;
        const oggi = new Date();
        const inizioGiorno = new Date(oggi);
        inizioGiorno.setHours(0, 0, 0, 0);
        const fineGiorno = new Date(inizioGiorno);
        fineGiorno.setDate(fineGiorno.getDate() + 1);

        const subtitle = oggi.toLocaleDateString("it-IT", {
            weekday: "long",
            day: "2-digit",
            month: "long",
            year: "numeric"
        });

        apriDashboardAppModal({
            title: "Appuntamenti di Oggi",
            subtitle: subtitle
        });

        try {
            const url = buildAppuntamentiUrl({
                startStr: formatDateTimeForApi(inizioGiorno),
                endStr: formatDateTimeForApi(fineGiorno)
            }, { includeFilters: false });

            const data = await fetchJsonOrThrow(
                url,
                { cache: "no-store" },
                "Errore caricamento appuntamenti di oggi"
            );
            if (sequence !== dashboardListSequence) return;

            const appuntamenti = (Array.isArray(data) ? data : [])
                .map(normalizzaEventoDashboard)
                .filter(Boolean)
                .sort((a, b) => a.start - b.start);

            renderDashboardListaAppuntamenti(appuntamenti, "Nessun appuntamento per oggi.");
        } catch (error) {
            if (sequence !== dashboardListSequence) return;
            renderDashboardListaAppuntamenti([], "Errore caricamento appuntamenti.");
            mostraToast(error.message || "Errore caricamento appuntamenti di oggi", "error");
        }
    }

    async function apriDashboardAppuntamentiSettimana() {
        const sequence = ++dashboardListSequence;
        const riferimento = calendar.getDate();
        const { monday, sundayExclusive } = getSettimanaRange(riferimento);
        const domenica = new Date(sundayExclusive);
        domenica.setDate(domenica.getDate() - 1);

        const subtitle = `${monday.toLocaleDateString("it-IT", { day: "2-digit", month: "short" })} - ${domenica.toLocaleDateString("it-IT", { day: "2-digit", month: "short", year: "numeric" })}`;

        apriDashboardAppModal({
            title: "Appuntamenti della Settimana",
            subtitle: subtitle
        });

        renderDashboardListaAppuntamenti([], 'Caricamento settimana…');
        try {
            const events = await fetchCalendarWeekEvents(riferimento);
            if (sequence !== dashboardListSequence) return;
            const appuntamenti = events.map(normalizzaEventoDashboard).filter(Boolean).sort((a, b) => a.start - b.start);
            renderDashboardListaAppuntamenti(appuntamenti, 'Nessun appuntamento nella settimana corrente.');
        } catch (_) {
            if (sequence !== dashboardListSequence) return;
            renderDashboardListaAppuntamenti([], 'Elenco non disponibile. Chiudi e riprova.');
        }
    }

    if (openAppuntamentiOggiBtn) {
        openAppuntamentiOggiBtn.addEventListener("click", apriDashboardAppuntamentiOggi);
    }

    if (openAppuntamentiSettimanaBtn) {
        openAppuntamentiSettimanaBtn.addEventListener("click", apriDashboardAppuntamentiSettimana);
    }

    if (closeDashboardAppModalBtn) {
        closeDashboardAppModalBtn.addEventListener("click", chiudiDashboardAppModal);
    }

    if (mobileMode) {
        creaFabMobile();
    }

});

function caricaPacchettiCliente(clienteId) {

    const select = document.getElementById("pacchettoSelect");
    if (!select) return Promise.resolve([]);

    select.innerHTML = '<option value="">Nessun pacchetto</option>';

    return fetch('/api/pacchetti_attivi/' + clienteId)
        .then(res => res.json())
        .then(data => {

            data.forEach(pac => {

                const option = document.createElement("option");
                option.value = pac.id;
                option.text = pac.nome + " (" + pac.sedute_rimanenti + " rimaste)" + (Number(pac.sedute_rimanenti) <= 2 ? " · In esaurimento" : "");
                option.dataset.servizio = pac.servizio_id;

                select.appendChild(option);
            });

            aggiornaQuickAssegnaPacchettoUI(data);
            return data;
        })
        .catch(error => {
            console.error("Errore caricamento pacchetti cliente:", error);
            aggiornaQuickAssegnaPacchettoUI([]);
            return [];
        });
}

function popolaTipiPacchettoSelectRapido() {
    const select = document.getElementById("quickTipoPacchettoSelect");
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">Seleziona pacchetto da assegnare</option>';

    tipiPacchettoData.forEach(tipo => {
        const option = document.createElement("option");
        option.value = tipo.id;
        option.textContent = `${tipo.nome} (${tipo.numero_sedute} sedute)`;
        if (tipo.servizio_id) option.dataset.servizio = tipo.servizio_id;
        select.appendChild(option);
    });

    if (currentValue && Array.from(select.options).some(opt => String(opt.value) === String(currentValue))) {
        select.value = currentValue;
    }
}

function caricaTipiPacchetto() {
    return fetch("/api/tipi_pacchetto")
        .then(res => res.json())
        .then(data => {
            tipiPacchettoData = Array.isArray(data) ? data : [];
            popolaTipiPacchettoSelectRapido();
            aggiornaQuickAssegnaPacchettoUI();
            return tipiPacchettoData;
        })
        .catch(error => {
            console.error("Errore caricamento tipi pacchetto:", error);
            tipiPacchettoData = [];
            popolaTipiPacchettoSelectRapido();
            aggiornaQuickAssegnaPacchettoUI();
            return [];
        });
}

function aggiornaQuickAssegnaPacchettoUI(pacchettiAttivi = null) {
    const box = document.getElementById("quickPacchettoAssignBox");
    const hint = document.getElementById("quickPacchettoHint");
    const tipoSelect = document.getElementById("quickTipoPacchettoSelect");
    const btn = document.getElementById("btnQuickAssegnaPacchetto");
    const clientePrimario = clientiSelezionati[0];

    if (!box || !hint || !tipoSelect || !btn) return;

    const hasTipiPacchetto = tipiPacchettoData.length > 0;
    tipoSelect.disabled = !hasTipiPacchetto;
    btn.disabled = !hasTipiPacchetto;

    if (!clientePrimario) {
        box.classList.add("quick-create-hidden");
        tipoSelect.value = "";
        return;
    }

    box.classList.remove("quick-create-hidden");
    const nomeCompleto = `${clientePrimario.nome || ""} ${clientePrimario.cognome || ""}`.trim();
    const hasAttivi = Array.isArray(pacchettiAttivi) ? pacchettiAttivi.length > 0 : false;

    let testo = hasAttivi
        ? `Pacchetti attivi trovati per ${nomeCompleto}. Puoi assegnarne un altro da qui.`
        : `Nessun pacchetto attivo per ${nomeCompleto}. Assegnane uno ora senza uscire.`;

    if (clientiSelezionati.length > 1) {
        testo += " Verrà assegnato al primo cliente selezionato.";
    }

    if (!hasTipiPacchetto) {
        testo = "Tipi pacchetto non disponibili al momento.";
    }

    hint.textContent = testo;
}

async function assegnaPacchettoRapidoDaAppuntamento() {
    const clientePrimario = clientiSelezionati[0];
    const tipoSelect = document.getElementById("quickTipoPacchettoSelect");
    const btn = document.getElementById("btnQuickAssegnaPacchetto");
    const pacchettoSelect = document.getElementById("pacchettoSelect");

    if (!clientePrimario) {
        mostraToast("Seleziona prima un cliente", "warning");
        return;
    }

    const tipoPacchettoId = (tipoSelect?.value || "").trim();
    if (!tipoPacchettoId) {
        mostraToast("Seleziona il pacchetto da assegnare", "warning");
        return;
    }

    if (btn?.disabled) return;
    setButtonLoading(btn, true, {
        label: "Assegnazione...",
        replaceContent: true
    });

    try {
        const payload = await fetchJsonOrThrow(
            `/api/clienti/${clientePrimario.id}/pacchetti`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tipo_pacchetto_id: tipoPacchettoId })
            },
            "Errore durante assegnazione pacchetto"
        );

        const pacchetti = await caricaPacchettiCliente(clientePrimario.id);
        if (calendar) calendar.refetchEvents();
        const nuovoPacchettoId = payload?.pacchetto?.id;

        if (nuovoPacchettoId && pacchettoSelect && pacchetti.some(pac => String(pac.id) === String(nuovoPacchettoId))) {
            pacchettoSelect.value = String(nuovoPacchettoId);
        } else if (pacchetti.length && pacchettoSelect) {
            const ultimo = pacchetti[pacchetti.length - 1];
            if (ultimo?.id) pacchettoSelect.value = String(ultimo.id);
        }

        if (tipoSelect) tipoSelect.value = "";
        mostraToast('Pacchetto assegnato. Gli appuntamenti futuri compatibili già presenti sono stati collegati fino alle sedute disponibili.', 'success');
    } catch (error) {
        console.error("Errore assegnazione pacchetto rapido:", error);
        mostraToast(error.message || "Errore assegnazione pacchetto", "error");
    } finally {
        setButtonLoading(btn, false, { replaceContent: true });
    }
}

function inizializzaAssegnaPacchettoRapido() {
    const btn = document.getElementById("btnQuickAssegnaPacchetto");
    const tipoSelect = document.getElementById("quickTipoPacchettoSelect");
    if (!btn || btn.dataset.bound === "1") return;

    btn.dataset.bound = "1";
    btn.addEventListener("click", assegnaPacchettoRapidoDaAppuntamento);

    if (tipoSelect) {
        tipoSelect.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            assegnaPacchettoRapidoDaAppuntamento();
        });
    }
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
        if (!await confermaSovrapposizioni([{ start_datetime: formatDateTimeForApi(evento.start), end_datetime: endISO }], evento.id)) {
            if (typeof info.revert === "function") info.revert();
            return;
        }
        await fetchJsonOrThrow('/api/appuntamenti/' + evento.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start_datetime: formatDateTimeForApi(evento.start),
                end_datetime: endISO
            })
        }, "Errore aggiornamento orario appuntamento");

        // Lo spostamento può rinumerare anche le altre sedute del pacchetto.
        calendar.refetchEvents();
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

function aggiornaRiepilogoNuovoEvento() {
    const riepilogo = document.getElementById("eventoRiepilogo");
    if (!riepilogo) return;

    const occupato = !!document.getElementById("eventoOccupato")?.checked;
    const ripeti = !!document.getElementById("eventoRipetiSettimanale")?.checked;
    const numero = Number.parseInt(document.getElementById("eventoNumeroOccorrenze")?.value, 10);
    const righe = Array.from(document.querySelectorAll("#eventoSlotPersonalizzatiList .event-custom-slot-row"));
    const dateAggiuntive = righe.filter(row => Array.from(row.querySelectorAll("input")).some(input => input.value)).length;
    const totale = ripeti ? Math.min(52, Math.max(2, numero || 2)) : 1 + dateAggiuntive;
    const orari = leggiDataOraDalModalNuovoEvento();
    const minuti = orari ? Math.round((orari.endLocal - orari.startLocal) / 60000) : 0;
    const durata = document.getElementById("eventoDurata");
    if (durata) durata.textContent = minuti > 0 ? `${minuti} min` : "Controlla gli orari";

    const tipo = occupato ? (totale === 1 ? "blocco occupato" : "blocchi occupati")
        : (totale === 1 ? "appuntamento" : "appuntamenti");
    riepilogo.textContent = `${totale} ${tipo}${minuti > 0 ? ` · ${minuti} min${totale > 1 ? " a seduta" : ""}` : ""}`;
    // Le date personalizzate possono avere durate diverse: non generalizzare la prima.
    if (!ripeti && dateAggiuntive > 0) riepilogo.textContent = `${totale} ${tipo} · orari personalizzati`;

    const inviaEmail = !!document.getElementById("eventoInviaConfermaEmail")?.checked;
    const conEmail = clientiSelezionati.filter(cliente => String(cliente.email || "").trim()
        || emailValidaNuovoEvento(leggiEmailNuovoEvento(cliente))).length;
    const statoEmail = document.getElementById("eventoRiepilogoEmail");
    if (statoEmail) {
        statoEmail.textContent = occupato ? "Nessun cliente associato"
            : !inviaEmail ? "Conferma email non richiesta"
            : conEmail > 0 ? `Conferma richiesta per ${conEmail} ${conEmail === 1 ? "persona" : "persone"}`
            : "Nessun indirizzo email disponibile";
    }

    const hintEmail = document.getElementById("eventoEmailHint");
    if (hintEmail) {
        const calendario = "Include il file per aggiungere la seduta al calendario.";
        hintEmail.textContent = !clientiSelezionati.length ? calendario
            : !conEmail ? "Puoi aggiungere qui sotto gli indirizzi email mancanti."
            : conEmail < clientiSelezionati.length ? `Indirizzo disponibile per ${conEmail} dei clienti selezionati. ${calendario}`
            : clientiSelezionati.length === 2 ? `La riceveranno entrambe le persone. ${calendario}` : calendario;
    }

    const badge = document.getElementById("eventoOpzioniAttive");
    if (badge) {
        const attive = [];
        if (document.getElementById("eventoNote")?.value.trim()) attive.push("Note");
        if (ripeti) attive.push("Serie");
        if (!ripeti && dateAggiuntive > 0) attive.push("Altre date");
        badge.textContent = attive.join(" · ");
        badge.hidden = attive.length === 0;
    }
}

function emailValidaNuovoEvento(value) {
    const email = String(value || '').trim();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function leggiEmailNuovoEvento(cliente) {
    const id = String(cliente.id);
    return String(document.getElementById('eventoEmailCliente-' + id)?.value ?? emailNuovoEvento.get(id) ?? '').trim();
}

function aggiornaCampiEmailNuovoEvento() {
    const box = document.getElementById('eventoEmailMancanti');
    const fields = document.getElementById('eventoEmailMancantiCampi');
    if (!box || !fields) return;
    for (const cliente of clientiSelezionati) {
        const id = String(cliente.id);
        if (String(cliente.email || '').trim()) emailNuovoEvento.delete(id);
        else {
            const input = document.getElementById('eventoEmailCliente-' + id);
            if (input) emailNuovoEvento.set(id, input.value);
        }
    }
    const selezionati = new Set(clientiSelezionati.map(cliente => String(cliente.id)));
    for (const id of emailNuovoEvento.keys()) if (!selezionati.has(id)) emailNuovoEvento.delete(id);
    const mancanti = clientiSelezionati.filter(cliente => !String(cliente.email || '').trim());
    box.hidden = mancanti.length === 0;
    fields.replaceChildren();
    mancanti.forEach(cliente => {
        const id = String(cliente.id);
        const row = document.createElement('div'); row.className = 'event-missing-email-field';
        const label = document.createElement('label');
        label.htmlFor = 'eventoEmailCliente-' + id;
        label.textContent = 'Email · ' + ([cliente.nome, cliente.cognome].filter(Boolean).join(' ') || 'Cliente');
        const input = document.createElement('input');
        input.id = label.htmlFor; input.type = 'email'; input.inputMode = 'email';
        input.autocomplete = 'email'; input.maxLength = 254; input.className = 'input-apple';
        input.placeholder = 'nome@esempio.it'; input.value = emailNuovoEvento.get(id) || '';
        input.setAttribute('aria-describedby', 'eventoEmailSalvataggioHint');
        const aggiornaBozza = () => {
            emailNuovoEvento.set(id, input.value);
            input.removeAttribute('aria-invalid');
            aggiornaRiepilogoNuovoEvento();
        };
        input.addEventListener('input', aggiornaBozza);
        input.addEventListener('change', aggiornaBozza);
        row.append(label, input); fields.appendChild(row);
    });
}

function raccogliEmailNuovoEvento(clienti) {
    const emails = [];
    for (const cliente of clienti) {
        if (String(cliente.email || '').trim()) continue;
        const id = String(cliente.id);
        const email = leggiEmailNuovoEvento(cliente);
        if (!email) continue;
        if (!emailValidaNuovoEvento(email)) {
            const input = document.getElementById('eventoEmailCliente-' + id);
            input?.setAttribute('aria-invalid', 'true'); input?.focus();
            mostraToast('Controlla l’indirizzo email di ' + [cliente.nome, cliente.cognome].filter(Boolean).join(' '), 'warning');
            return null;
        }
        emails.push({ cliente, email });
    }
    return emails;
}

async function salvaEmailClienteNuovoEvento({ cliente, email }) {
    const aggiornato = await fetchJsonOrThrow('/api/clienti/' + encodeURIComponent(cliente.id) + '/email', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
    }, 'Impossibile salvare l’email del cliente. L’appuntamento non è stato ancora creato.');
    if (String(aggiornato?.id) !== String(cliente.id) || !emailValidaNuovoEvento(aggiornato?.email)) {
        throw new Error('Salvataggio dell’email non confermato. Verifica l’anagrafica prima di riprovare.');
    }
    cliente.email = aggiornato.email;
    for (const persona of [...tuttiClienti, ...clientiSelezionati]) {
        if (String(persona.id) === String(cliente.id)) persona.email = aggiornato.email;
    }
    emailNuovoEvento.delete(String(cliente.id));
}

function inizializzaRiepilogoNuovoEvento() {
    const modal = document.getElementById("eventoModal");
    if (!modal || modal.dataset.summaryBound === "1") return;
    modal.dataset.summaryBound = "1";
    modal.addEventListener("input", aggiornaRiepilogoNuovoEvento);
    modal.addEventListener("change", aggiornaRiepilogoNuovoEvento);
}

function apriModal() {
    clientiSelezionati = [];
    emailNuovoEvento.clear();

    if (!selectedStart || !selectedEnd) {
        impostaSelezioneDaData(calcolaStartDefaultPerMobile());
    }

    const modal = document.getElementById("eventoModal");
    requestAnimationFrame(() => modal.style.display = "block");
    inizializzaRiepilogoNuovoEvento();
    modal.querySelectorAll("details").forEach(details => { details.open = false; });
    const contenuto = modal.querySelector(".event-create-body");
    if (contenuto) contenuto.scrollTop = 0;

    inizializzaRicercaClienti();
    aggiornaClientiSelezionati();
    sincronizzaCampiDataOraNuovoEvento();
    resetRicorrenzaEvento();
    resetSlotPersonalizzati();
    resetStatoOccupato();

    const noteInput = document.getElementById("eventoNote");
    if (noteInput) noteInput.value = "";
    aggiornaRiepilogoNuovoEvento();

    const searchInput = document.getElementById("searchCliente");
    if (searchInput) requestAnimationFrame(() => searchInput.focus());
}

function chiudiModal() {
    const m = document.getElementById("eventoModal");
    if (!m) return;
    requestAnimationFrame(() => m.style.display = "none");
}

function mostraEsitoEmailConferma(esito) {
    if (!esito?.requested) return;

    const inviate = Number(esito.sent_count) || 0;
    const fallite = Number(esito.failed_count) || 0;
    const senzaEmail = Number(esito.skipped_no_email_count) || 0;
    const messaggiErrore = [...new Set((esito.errors || []).map(errore => errore.message).filter(Boolean))];
    const motivoErrore = messaggiErrore.join(" ");

    if (inviate > 0 && fallite === 0 && senzaEmail === 0 && !messaggiErrore.length) {
        mostraToast(
            inviate === 1 ? "Email di conferma inviata." : `Inviate ${inviate} email di conferma.`,
            "success"
        );
        return;
    }

    if (inviate > 0) {
        const dettagli = [];
        if (fallite > 0) dettagli.push(`${fallite} ${fallite === 1 ? "non inviata" : "non inviate"}`);
        if (senzaEmail > 0) dettagli.push(`${senzaEmail} ${senzaEmail === 1 ? "cliente" : "clienti"} senza email`);
        if (motivoErrore) dettagli.push(motivoErrore);
        mostraToast(`Conferme inviate: ${inviate}. ${dettagli.join(", ")}.`, "warning");
        return;
    }

    if (fallite > 0) {
        mostraToast(motivoErrore || "Email di conferma non inviata: controlla la configurazione email.", "warning");
        return;
    }

    if (senzaEmail > 0) {
        mostraToast("Email di conferma non inviata: il cliente non ha un indirizzo email.", "info");
    } else if (esito.skipped_already_sent_count > 0) {
        mostraToast("Conferma già inviata: nessuna email duplicata.", "info");
    }
}

async function caricaConfermeEmail(appuntamentoId) {
    const list = document.getElementById("confermeEmailList");
    if (!list) return;
    list.textContent = "Caricamento esiti...";
    const labels = { sent: "Invio riuscito", failed: "Invio fallito", unknown: "Esito da verificare", sending: "Invio in corso", pending: "Invio non completato",
        not_requested: "Conferma non richiesta", untracked: "Nessun invio registrato", missing_email: "Indirizzo email mancante", outdated: "Dati modificati: da riconfermare" };
    try {
        const payload = await fetchJsonOrThrow(`/api/appuntamenti/${appuntamentoId}/conferme`, {}, "Impossibile leggere gli esiti email");
        if (String(window.eventoSelezionato?.id) !== String(appuntamentoId)) return;
        list.replaceChildren();
        if (!payload.destinatari.length) { list.textContent = "Nessun cliente associato."; return; }
        payload.destinatari.forEach(persona => {
            const row = document.createElement("div"); row.className = "confirmation-person";
            const info = document.createElement("div");
            const name = document.createElement("strong"); name.textContent = persona.nome || "Cliente";
            const status = document.createElement("span"); status.className = `confirmation-status status-${persona.status}`;
            status.textContent = labels[persona.status] || "Esito non disponibile";
            info.append(name, status);
            if (persona.updated_at) {
                const when = document.createElement("small");
                when.textContent = new Date(persona.updated_at).toLocaleString("it-IT");
                info.appendChild(when);
            }
            if (persona.message) { const reason = document.createElement("small"); reason.textContent = persona.message; info.appendChild(reason); }
            if (!persona.has_email) { const missing = document.createElement("small"); missing.textContent = "Aggiungi un indirizzo nell'anagrafica per inviare."; info.appendChild(missing); }
            row.appendChild(info);
            if (persona.can_send) {
                const button = document.createElement("button"); button.type = "button"; button.className = "confirmation-retry";
                button.textContent = ["failed", "unknown"].includes(persona.status) ? "Riprova" : "Invia conferma";
                button.addEventListener("click", async () => {
                    const warning = persona.status === "unknown" ? "L'email potrebbe essere già partita. Reinviandola potresti duplicarla. Procedere?"
                        : persona.status === "untracked" ? "Per questo appuntamento non esiste uno storico degli invii. Una conferma potrebbe essere già stata inviata. Inviarne una ora?"
                        : `Inviare la conferma a ${persona.nome}?`;
                    if (!window.confirm(warning)) return;
                    button.disabled = true;
                    try {
                        const result = await fetchJsonOrThrow(`/api/appuntamenti/${appuntamentoId}/conferme`, {
                            method: "POST", headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ cliente_id: persona.cliente_id, conferma_esito_incerto: persona.status === "unknown" })
                        }, "Errore nel reinvio della conferma");
                        mostraEsitoEmailConferma(result.email_confirmation);
                    } catch (error) { mostraToast(error.message, "error"); }
                    finally {
                        if (String(window.eventoSelezionato?.id) === String(appuntamentoId)) await caricaConfermeEmail(appuntamentoId);
                    }
                });
                row.appendChild(button);
            }
            list.appendChild(row);
        });
    } catch (error) {
        if (String(window.eventoSelezionato?.id) === String(appuntamentoId)) list.textContent = error.message;
    }
}

async function confermaSovrapposizioni(slots, ignoreId = null) {
    const result = await fetchJsonOrThrow("/api/appuntamenti/conflitti", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slots, ignore_id: ignoreId })
    }, "Impossibile verificare le sovrapposizioni. Riprova prima di salvare.");
    if (!result.count && !result.internal_count) return true;
    return window.confirm(`Attenzione: ${result.count || 0} appuntamenti o blocchi già presenti si sovrappongono agli orari scelti.${result.internal_count ? " Anche alcune delle nuove date si sovrappongono tra loro." : ""} Vuoi procedere comunque?`);
}

async function salvaEvento() {

    const servizioId = document.getElementById("servizioSelect").value;
    const pacchettoId = document.getElementById("pacchettoSelect")?.value || null;
    const repeatSettimanale = !!document.getElementById("eventoRipetiSettimanale")?.checked;
    const occorrenzeRaw = document.getElementById("eventoNumeroOccorrenze")?.value;
    const dataOrarioCustom = leggiDataOraDalModalNuovoEvento();
    const customSlotsResult = leggiSlotPersonalizzatiDalModal();
    const salvaBtn = document.getElementById("btnSalvaEvento");
    const note = document.getElementById("eventoNote")?.value.trim() || "";
    const occupato = !!document.getElementById("eventoOccupato")?.checked;
    const inviaConfermaEmail = !!document.getElementById("eventoInviaConfermaEmail")?.checked;
    const clientiEvento = clientiSelezionati.slice();

    if (salvaBtn?.disabled) return;

    if (!dataOrarioCustom) {
        mostraToast("Inserisci data e orario validi", "warning");
        return;
    }

    if (customSlotsResult?.error) {
        mostraToast(customSlotsResult.error, "warning");
        return;
    }

    const customSlots = customSlotsResult?.slots || [];

    const { startLocal, endLocal } = dataOrarioCustom;

    if (endLocal <= startLocal) {
        mostraToast("L'ora di fine deve essere successiva all'ora di inizio", "warning");
        return;
    }

    selectedStart = formatDateTimeForApi(startLocal);
    selectedEnd = formatDateTimeForApi(endLocal);

    if ((!occupato && clientiEvento.length === 0) || !servizioId) {
        mostraToast(
            occupato ? "Seleziona un servizio" : "Seleziona almeno un cliente e un servizio",
            "warning"
        );
        return;
    }

    let occorrenze = 1;
    if (repeatSettimanale) {
        const parsedOccorrenze = Number.parseInt(occorrenzeRaw, 10);
        if (!Number.isFinite(parsedOccorrenze) || parsedOccorrenze < 2 || parsedOccorrenze > 52) {
            mostraToast("Numero appuntamenti non valido (2-52)", "warning");
            return;
        }
        occorrenze = parsedOccorrenze;
    }

    if (repeatSettimanale && customSlots.length > 0) {
        mostraToast("Usa o la serie settimanale o gli slot personalizzati, non entrambi.", "warning");
        return;
    }

    const emailDaSalvare = occupato ? [] : raccogliEmailNuovoEvento(clientiEvento);
    if (emailDaSalvare === null) return;

    let slotsPersonalizzatiPayload = null;
    if (customSlots.length > 0) {
        slotsPersonalizzatiPayload = [
            {
                start_datetime: selectedStart,
                end_datetime: selectedEnd
            },
            ...customSlots.map(slot => ({
                start_datetime: formatDateTimeForApi(slot.startLocal),
                end_datetime: formatDateTimeForApi(slot.endLocal)
            }))
        ];
    }

    setButtonLoading(salvaBtn, true, { label: "Salvataggio..." });
    let emailSalvate = 0;
    document.querySelectorAll('#eventoEmailMancantiCampi input').forEach(input => { input.disabled = true; });

    try {
        const slotsDaVerificare = slotsPersonalizzatiPayload || Array.from({ length: occorrenze }, (_, index) => {
            const start = new Date(startLocal); const end = new Date(endLocal);
            start.setDate(start.getDate() + 7 * index); end.setDate(end.getDate() + 7 * index);
            return { start_datetime: formatDateTimeForApi(start), end_datetime: formatDateTimeForApi(end) };
        });
        if (!await confermaSovrapposizioni(slotsDaVerificare)) return;
        for (const voce of emailDaSalvare) {
            await salvaEmailClienteNuovoEvento(voce);
            emailSalvate++;
        }
        const payload = await fetchJsonOrThrow('/api/appuntamenti', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clienti_ids: occupato ? [] : clientiEvento.map(c => c.id),
                servizio_id: servizioId,
                pacchetto_cliente_id: occupato ? null : pacchettoId,
                occupato,
                invia_conferma_email: occupato ? false : inviaConfermaEmail,
                start_datetime: selectedStart,
                end_datetime: selectedEnd,
                ripeti_settimanale: slotsPersonalizzatiPayload ? false : repeatSettimanale,
                occorrenze: slotsPersonalizzatiPayload ? 1 : occorrenze,
                slots_personalizzati: slotsPersonalizzatiPayload,
                note,
                durata_minuti: Math.round((new Date(selectedEnd) - new Date(selectedStart)) / 60000)
            })
        }, "Errore nel salvataggio appuntamento");

        chiudiModal();
        calendar.refetchEvents();
        clientiSelezionati = [];
        aggiornaClientiSelezionati();

        const createdCount = Number.parseInt(payload?.created_count, 10);
        const testoAppuntamento = Number.isFinite(createdCount) && createdCount > 1
            ? `Creati ${createdCount} appuntamenti.` : 'Appuntamento creato con successo.';
        const testoEmail = emailSalvate ? (emailSalvate === 1 ? ' Email salvata in anagrafica.' : ' Email salvate nelle anagrafiche.') : '';
        mostraToast(testoAppuntamento + testoEmail, 'success');
        if (payload?.package_uncovered_count > 0) {
            mostraToast(`${payload.package_uncovered_count} appuntamenti non sono coperti da un pacchetto compatibile con sedute disponibili.`, 'warning');
        }
        mostraEsitoEmailConferma(payload?.email_confirmation);
    } catch (error) {
        console.error("Errore:", error);
        const messaggio = (error.message || 'Errore nel creare appuntamento')
            + (emailSalvate ? ' Gli indirizzi già salvati restano in anagrafica.' : '');
        mostraToast(messaggio, 'error');
    } finally {
        aggiornaCampiEmailNuovoEvento();
        aggiornaRiepilogoNuovoEvento();
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
    const evento = window.eventoSelezionato;
    if (!evento) return;
    const extended = evento.extendedProps || {};
    const ids = extended.clienti_ids || [];
    const nomi = Array.isArray(extended.clienti) ? extended.clienti : String(extended.clienti || '').split('+').map(nome => nome.trim());
    const titolo = document.getElementById('editAppointmentTitle');
    titolo.replaceChildren();
    if (ids.length) {
        ids.forEach((id, index) => {
            if (index) titolo.appendChild(document.createTextNode(' + '));
            const link = document.createElement('a');
            link.href = '/cliente/' + encodeURIComponent(id);
            link.textContent = nomi[index] || 'Cliente';
            titolo.appendChild(link);
        });
    } else {
        titolo.textContent = extended.occupato ? 'Occupato' : nomi.join(' + ') || 'Appuntamento';
    }
    const meta = document.getElementById('editAppointmentMeta');
    if (meta) meta.textContent = (extended.servizio || '') + (extended.numero_seduta ? ' · Seduta ' + extended.numero_seduta : '');
    const end = evento.end || new Date(evento.start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);
    document.getElementById('dataModifica').value = formatDateForInput(evento.start);
    document.getElementById('oraInizioModifica').value = formatTimeForInput(evento.start);
    document.getElementById('oraFineModifica').value = formatTimeForInput(end);
    document.getElementById('noteModifica').value = extended.note || '';
    const modal = document.getElementById('modificaModal');
    autoClosePromemoria();
    const whatsapp = document.getElementById('whatsappDestinatari');
    if (whatsapp) { whatsapp.hidden = true; whatsapp.replaceChildren(); }
    document.getElementById('confermeEmailSection').hidden = !!extended.occupato;
    requestAnimationFrame(() => { modal.style.display = 'block'; modal.classList.add('modal-active'); });
    if (!extended.occupato) caricaConfermeEmail(evento.id);
}
function chiudiModificaModal() {
    const modal = document.getElementById("modificaModal");
    if (!modal) return;

    autoClosePromemoria();
    modal.classList.remove("modal-active");
    requestAnimationFrame(() => modal.style.display = "none");
}

function chiudiDashboardAppModal() {
    const modal = document.getElementById("dashboardAppModal");
    if (!modal) return;
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
    const dashboardAppModal = document.getElementById("dashboardAppModal");

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

    if (dashboardAppModal && event.target === dashboardAppModal) {
        chiudiDashboardAppModal();
    }
}, { passive: true });

window.addEventListener("keydown", function(event) {

    if (event.key !== "Escape") return;

    const eventoModal = document.getElementById("eventoModal");
    const clienteModal = document.getElementById("clienteModal");
    const modificaModal = document.getElementById("modificaModal");
    const dashboardAppModal = document.getElementById("dashboardAppModal");

    if (eventoModal && eventoModal.style.display === "block") {
        chiudiModal();
    }

    if (clienteModal && clienteModal.style.display === "block") {
        chiudiModalCliente();
    }

    if (modificaModal && modificaModal.style.display === "block") {
        chiudiModificaModal();
    }

    if (dashboardAppModal && dashboardAppModal.style.display === "block") {
        chiudiDashboardAppModal();
    }
}, { passive: true });

async function salvaModifiche() {

    const data = document.getElementById("dataModifica").value;
    const oraInizio = document.getElementById("oraInizioModifica").value;
    const oraFine = document.getElementById("oraFineModifica").value;
    const note = document.getElementById("noteModifica").value.trim();
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
        const prima = window.eventoSelezionato;
        if (start_datetime !== formatDateTimeForApi(prima.start) || end_datetime !== (prima.end ? formatDateTimeForApi(prima.end) : "")) {
            if (!await confermaSovrapposizioni([{ start_datetime, end_datetime }], prima.id)) return;
        }
        await fetchJsonOrThrow('/api/appuntamenti/' + window.eventoSelezionato.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                start_datetime: start_datetime,
                end_datetime: end_datetime,
                note
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

            if (contentType && contentType.includes("application/json")) {
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || "Errore invio email");
                return data;
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
                mostraToast(data.message || "Errore invio email", "error");
            }
        })
        .catch(error => {
            console.error("Errore invio promemoria:", error);
            mostraToast(error.message || "Errore invio email", "error");
        });
}


async function inviaPromemoriaWhatsApp() {
    const evento = window.eventoSelezionato;
    if (!evento) { mostraToast('Nessun appuntamento selezionato', 'error'); return; }
    const ids = evento.extendedProps?.clienti_ids || [];
    const box = document.getElementById('whatsappDestinatari');
    if (!box || !ids.length) { mostraToast('Cliente non disponibile', 'error'); return; }
    box.hidden = false; box.textContent = 'Caricamento destinatari...';
    try {
        const persone = await Promise.all(ids.map(id => fetchJsonOrThrow('/api/clienti/' + encodeURIComponent(id), {}, 'Errore recupero destinatario')));
        if (String(window.eventoSelezionato?.id) !== String(evento.id)) return;
        box.replaceChildren();
        const help = document.createElement('p'); help.className = 'edit-help';
        help.textContent = 'Apri WhatsApp per ciascuna persona e conferma l’invio nell’app.'; box.appendChild(help);
        persone.forEach((persona, index) => {
            const nome = [persona.nome, persona.cognome].filter(Boolean).join(' ') || 'Cliente';
            let numero = String(persona.telefono || '').replace(/[^0-9]/g, '');
            if (numero.startsWith('00')) numero = numero.slice(2);
            if (numero.length === 10 && numero.startsWith('3')) numero = '39' + numero;
            if (numero.length < 8 || numero.length > 15) {
                const missing = document.createElement('p'); missing.className = 'edit-help'; missing.textContent = nome + ': numero non disponibile o non valido.'; box.appendChild(missing); return;
            }
            const extended = evento.extendedProps || {};
            const servizio = extended.servizio || 'trattamento';
            const seduta = extended.numero_seduta && (servizio.toLowerCase().includes('coppia') || index === 0)
                ? ' Questa sarà la seduta n° ' + extended.numero_seduta + ' del tuo pacchetto.' : '';
            const messaggio = 'Ciao ' + (persona.nome || '') + ', ti ricordo l’appuntamento di ' + servizio + ' il ' + evento.start.toLocaleDateString('it-IT') + ' alle ' + formatTimeForInput(evento.start) + '.' + seduta + ' A presto!';
            const link = document.createElement('a'); link.className = 'whatsapp-person-link';
            link.href = 'https://wa.me/' + numero + '?text=' + encodeURIComponent(messaggio); link.target = '_blank'; link.rel = 'noopener noreferrer';
            link.textContent = 'WhatsApp · ' + nome;
            link.addEventListener('click', () => { link.classList.add('whatsapp-opened'); mostraToast('Conferma l’invio in WhatsApp.', 'info'); });
            box.appendChild(link);
        });
    } catch (error) { if (String(window.eventoSelezionato?.id) === String(evento.id)) box.textContent = error.message; }
}

function inviaPromemoriaMail() {
    mostraToast("Usa le conferme email per inviare il riepilogo a ciascun cliente.", "info");
    document.getElementById("confermeEmailSection")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    autoClosePromemoria();
}

function inviaPromemoriaSMS() {
    mostraToast("Invio SMS non configurato.", "info");
    autoClosePromemoria();
}

function togglePromemoriaOptions() {
    const mainBtn = document.getElementById("btnPromemoriaMain");
    if (!mainBtn) return;
    impostaStatoPromemoria(mainBtn.getAttribute("aria-expanded") !== "true");
}

function impostaStatoPromemoria(aperto) {
    const options = document.getElementById("promemoriaOptions");
    const mainBtn = document.getElementById("btnPromemoriaMain");
    if (!options || !mainBtn) return;

    options.hidden = !aperto;
    options.classList.toggle("promemoria-hidden", !aperto);
    options.classList.toggle("promemoria-visible", aperto);
    mainBtn.setAttribute("aria-expanded", String(aperto));
}

function autoClosePromemoria() {
    impostaStatoPromemoria(false);
}


/* ===============================
   CLIENTI
=================================*/

function caricaClienti() {
    return fetch('/api/clienti')
        .then(res => res.json())
        .then(data => {
            tuttiClienti = data;
            return data;
        })
        .catch(error => {
            console.error("Errore caricamento clienti:", error);
            return [];
        });
}

function inizializzaRicercaClienti() {

    const searchInput = document.getElementById("searchCliente");
    const risultatiDiv = document.getElementById("risultatiClienti");
    const selezionatiDiv = document.getElementById("clientiSelezionati");
    const quickCreateBox = document.getElementById("quickClienteCreateBox");
    const quickHint = document.getElementById("quickClienteHint");
    const quickNome = document.getElementById("quickNomeCliente");
    const quickCognome = document.getElementById("quickCognomeCliente");
    const quickTelefono = document.getElementById("quickTelefonoCliente");
    const quickEmail = document.getElementById("quickEmailCliente");
    const quickSaveBtn = document.getElementById("btnQuickSaveCliente");

    if (!searchInput || !risultatiDiv || !selezionatiDiv) return;

    let quickSeedValue = "";

    searchInput.value = "";
    risultatiDiv.innerHTML = "";
    risultatiDiv.style.display = "none";

    let debounceTimer;

    function normalizzaTesto(value) {
        return (value || "").replace(/\s+/g, " ").trim();
    }

    function splitNomeCognome(valoreRicerca) {
        const clean = normalizzaTesto(valoreRicerca);
        if (!clean) return { nome: "", cognome: "" };
        const parti = clean.split(" ");
        if (parti.length === 1) {
            return { nome: parti[0], cognome: "" };
        }
        return {
            nome: parti[0],
            cognome: parti.slice(1).join(" ")
        };
    }

    function nascondiQuickCreate(clearFields = false) {
        if (!quickCreateBox) return;
        quickCreateBox.classList.add("quick-create-hidden");
        quickSeedValue = "";
        if (clearFields) {
            if (quickNome) quickNome.value = "";
            if (quickCognome) quickCognome.value = "";
            if (quickTelefono) quickTelefono.value = "";
            if (quickEmail) quickEmail.value = "";
        }
    }

    function mostraQuickCreate(valoreInput) {
        if (!quickCreateBox || !quickHint) return;

        const queryLabel = normalizzaTesto(valoreInput);
        quickCreateBox.classList.remove("quick-create-hidden");
        quickHint.textContent = `Nessun cliente trovato per "${queryLabel}". Puoi crearlo subito.`;

        if (queryLabel && queryLabel !== quickSeedValue) {
            const { nome, cognome } = splitNomeCognome(queryLabel);
            if (quickNome) quickNome.value = nome;
            if (quickCognome) quickCognome.value = cognome;
            if (quickTelefono) quickTelefono.value = "";
            if (quickEmail) quickEmail.value = "";
            quickSeedValue = queryLabel;
        }
    }

    async function salvaClienteRapidoDaAppuntamento() {
        if (clientiSelezionati.length >= 2) {
            mostraToast("Hai già selezionato 2 clienti", "info");
            return;
        }

        const nome = normalizzaTesto(quickNome?.value);
        const cognome = normalizzaTesto(quickCognome?.value);
        const telefono = normalizzaTesto(quickTelefono?.value);
        const email = normalizzaTesto(quickEmail?.value);

        if (!nome || !cognome) {
            mostraToast("Inserisci nome e cognome del cliente", "warning");
            return;
        }

        if (quickSaveBtn?.disabled) return;
        setButtonLoading(quickSaveBtn, true, {
            label: "Salvataggio...",
            replaceContent: true
        });

        try {
            const payload = {
                nome: nome,
                cognome: cognome,
                telefono: telefono || null,
                email: email || null
            };

            const response = await fetchJsonOrThrow("/api/clienti", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            }, "Errore creazione cliente rapido");

            let clienteCreato = Array.isArray(response) ? response[0] : response;
            if (!clienteCreato || !clienteCreato.id) {
                const refreshed = await caricaClienti();
                clienteCreato = refreshed.find(c =>
                    normalizzaTesto(c.nome).toLowerCase() === nome.toLowerCase() &&
                    normalizzaTesto(c.cognome).toLowerCase() === cognome.toLowerCase()
                );
            } else if (!tuttiClienti.find(c => String(c.id) === String(clienteCreato.id))) {
                tuttiClienti.unshift(clienteCreato);
            }

            if (!clienteCreato) {
                mostraToast("Cliente creato. Cercalo per selezionarlo.", "success");
                nascondiQuickCreate(true);
                searchInput.value = "";
                risultatiDiv.innerHTML = "";
                risultatiDiv.style.display = "none";
                return;
            }

            if (!clientiSelezionati.find(c => String(c.id) === String(clienteCreato.id))) {
                clientiSelezionati.push(clienteCreato);
            }

            aggiornaClientiSelezionati();
            nascondiQuickCreate(true);
            searchInput.value = "";
            risultatiDiv.innerHTML = "";
            risultatiDiv.style.display = "none";
            mostraToast("Cliente creato e selezionato", "success");
        } catch (error) {
            console.error("Errore creazione cliente rapido:", error);
            mostraToast(error.message || "Errore creazione cliente", "error");
        } finally {
            setButtonLoading(quickSaveBtn, false, { replaceContent: true });
        }
    }

    if (quickSaveBtn) {
        quickSaveBtn.onclick = salvaClienteRapidoDaAppuntamento;
    }

    [quickNome, quickCognome, quickTelefono, quickEmail].forEach(input => {
        if (!input) return;
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            salvaClienteRapidoDaAppuntamento();
        });
    });

    nascondiQuickCreate(true);

    searchInput.oninput = function() {

        clearTimeout(debounceTimer);

        debounceTimer = setTimeout(() => {

            const rawValue = this.value || "";
            const valore = normalizzaTesto(rawValue).toLowerCase();
            const queryLabel = normalizzaTesto(rawValue);
            risultatiDiv.innerHTML = "";

            if (valore.length < 1) {
                risultatiDiv.style.display = "none";
                nascondiQuickCreate(true);
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
                    nascondiQuickCreate(true);
                    searchInput.value = "";
                };

                risultatiDiv.appendChild(div);
            });

            risultatiDiv.style.display = filtrati.length > 0 ? "block" : "none";

            const exactMatch = tuttiClienti.some(c => {
                const fullName = `${c.nome || ""} ${c.cognome || ""}`.trim().toLowerCase();
                return fullName === valore;
            });

            const showQuickCreate = (
                queryLabel.length >= 2 &&
                filtrati.length === 0 &&
                !exactMatch &&
                clientiSelezionati.length < 2
            );

            if (showQuickCreate) {
                mostraQuickCreate(queryLabel);
            } else {
                nascondiQuickCreate(true);
            }

        }, 120);
    };
}

function aggiornaClientiSelezionati() {

    const selezionatiDiv = document.getElementById("clientiSelezionati");
    if (!selezionatiDiv) return;
    selezionatiDiv.innerHTML = "";

    clientiSelezionati.forEach(cliente => {

        const badge = document.createElement("button");
        badge.type = "button";
        badge.className = "event-client-chip";
        badge.setAttribute("aria-label", `Rimuovi ${cliente.nome || ""} ${cliente.cognome || ""}`.trim());
        badge.textContent = cliente.nome + " " + cliente.cognome + " ✕";

        badge.onclick = function() {
            clientiSelezionati = clientiSelezionati.filter(c => c.id !== cliente.id);
            aggiornaClientiSelezionati();
        };

        selezionatiDiv.appendChild(badge);
    });
    aggiornaCampiEmailNuovoEvento();
    aggiornaRiepilogoNuovoEvento();

    if (clientiSelezionati.length > 0) {
        caricaPacchettiCliente(clientiSelezionati[0].id);
    } else {
        const pacchettoSelect = document.getElementById("pacchettoSelect");
        if (pacchettoSelect) {
            pacchettoSelect.innerHTML = '<option value="">Nessun pacchetto</option>';
        }
        aggiornaQuickAssegnaPacchettoUI([]);
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
