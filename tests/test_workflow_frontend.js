const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

class Element {
    constructor(tag = 'div') {
        this.tag = tag; this.children = []; this.style = { setProperty(name, value) { this[name] = value; } }; this.dataset = {}; this.attributes = {};
        this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
        this.textContent = ''; this.innerHTML = ''; this.listeners = {}; this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name), remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name), toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name),
        };
    }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.children.push(item); return item; }
    replaceChildren(...items) { this.children = items; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    focus() { this.focused = true; }
    getBoundingClientRect() { return { height: this.height || 100, left: 30, top: 40, bottom: 140 }; }
}

function mainContext() {
    const nodes = {};
    const document = {
        body: new Element('body'),
        getElementById: id => nodes[id] || null,
        querySelectorAll: selector => selector === '#eventoEmailMancantiCampi input'
            ? (nodes.eventoEmailMancantiCampi?.children || []).flatMap(row => row.children.filter(child => child.tag === 'input')) : [],
        addEventListener() {},
        createElement: tag => {
            const element = new Element(tag);
            Object.defineProperty(element, 'id', { get() { return this._id; }, set(value) { this._id = value; nodes[value] = this; } });
            return element;
        },
        createTextNode: text => ({ textContent: text }),
    };
    const context = vm.createContext({ document, window: { addEventListener() {}, confirm: () => false,
        matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800 }, console,
        requestAnimationFrame: fn => fn(), setTimeout, clearTimeout, URLSearchParams });
    vm.runInContext(fs.readFileSync(path.join(root, 'static/main.js'), 'utf8'), context);
    context.mostraToast = () => {};
    return { context, nodes };
}

test('Cancelling overlap warning never creates an appointment', async () => {
    const { context, nodes } = mainContext();
    for (const id of ['servizioSelect', 'pacchettoSelect', 'eventoRipetiSettimanale', 'eventoNumeroOccorrenze',
        'eventoData', 'eventoOraInizio', 'eventoOraFine', 'eventoNote', 'eventoOccupato', 'eventoInviaConfermaEmail', 'btnSalvaEvento']) nodes[id] = new Element();
    nodes.servizioSelect.value = '20'; nodes.eventoData.value = '2026-11-11';
    nodes.eventoOraInizio.value = '10:00'; nodes.eventoOraFine.value = '11:00';
    vm.runInContext('clientiSelezionati = [{id: "101"}];', context);
    const calls = [];
    context.fetchJsonOrThrow = async url => { calls.push(url); return { count: 1, internal_count: 0 }; };
    await context.salvaEvento();
    assert.deepEqual(calls, ['/api/appuntamenti/conflitti']);
    assert.equal(nodes.btnSalvaEvento.disabled, false);
    context.window.confirm = () => true;
    context.chiudiModal = () => {};
    context.aggiornaClientiSelezionati = () => {};
    vm.runInContext('calendar = {refetchEvents() {}};', context);
    context.fetchJsonOrThrow = async url => {
        calls.push(url);
        return url.endsWith('/conflitti') ? { count: 1 } : { created_count: 1 };
    };
    await context.salvaEvento();
    assert.equal(calls.filter(url => url === '/api/appuntamenti').length, 1);
});

test('WhatsApp provides a separate manually opened link for both clients', async () => {
    const { context, nodes } = mainContext();
    nodes.whatsappDestinatari = new Element();
    context.window.location = {};
    context.window.eventoSelezionato = {
        id: '42', start: new Date('2026-11-11T10:00:00'),
        extendedProps: { clienti_ids: ['101', '202'], servizio: 'Ginnastica di coppia', numero_seduta: 3 },
    };
    context.fetchJsonOrThrow = async url => url.endsWith('101')
        ? { nome: 'Mario', telefono: '3331111111' } : { nome: 'Anna', telefono: '+39 3332222222' };
    await context.inviaPromemoriaWhatsApp();
    const links = nodes.whatsappDestinatari.children.filter(item => item.tag === 'a');
    assert.equal(links.length, 2);
    assert.match(links[0].href, /^https:\/\/wa.me\/393331111111\?text=/);
    assert.match(links[1].href, /^https:\/\/wa.me\/393332222222\?text=/);
    assert.match(decodeURIComponent(links[0].href), /Ciao Mario/);
    assert.match(decodeURIComponent(links[1].href), /Ciao Anna/);
    assert.ok(links.every(link => decodeURIComponent(link.href).includes('seduta n° 3')));
    assert.equal(context.window.location.href, undefined);
});

test('Confirmation list does not overwrite a different selected appointment', async () => {
    const { context, nodes } = mainContext();
    nodes.confermeEmailList = new Element();
    context.window.eventoSelezionato = { id: '42' };
    let resolve;
    context.fetchJsonOrThrow = () => new Promise(done => { resolve = done; });
    const pending = context.caricaConfermeEmail('42');
    context.window.eventoSelezionato = { id: '43' };
    nodes.confermeEmailList.textContent = 'Nuovo appuntamento';
    resolve({ destinatari: [{ nome: 'Vecchio cliente' }] });
    await pending;
    assert.equal(nodes.confermeEmailList.textContent, 'Nuovo appuntamento');
});

test('Archive searches full names with accents and preserves both views', () => {
    const nodes = Object.fromEntries(['searchInput', 'noResults', 'clientiVisibili', 'gridViewBtn', 'listViewBtn', 'clientiContainer'].map(id => [id, new Element()]));
    const clients = [['Élodie', 'Rossi'], ['Mario', 'Bianchi']].map(([nome, cognome]) => {
        const item = new Element('a'); item.setAttribute('data-nome', nome); item.setAttribute('data-cognome', cognome); return item;
    });
    const document = { getElementById: id => nodes[id], querySelectorAll: () => clients };
    const context = vm.createContext({ document });
    const script = fs.readFileSync(path.join(root, 'templates/clienti.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInContext(script, context);
    nodes.searchInput.value = 'elodie rossi'; nodes.searchInput.listeners.input.call(nodes.searchInput);
    assert.equal(clients[0].style.display, 'block'); assert.equal(clients[1].style.display, 'none');
    assert.equal(nodes.clientiVisibili.textContent, '1 cliente');
    nodes.listViewBtn.listeners.click();
    assert.equal(nodes.clientiContainer.classes.has('list-view'), true);
    assert.equal(nodes.listViewBtn.getAttribute('aria-pressed'), 'true');
    nodes.searchInput.value = ''; nodes.searchInput.listeners.input.call(nodes.searchInput);
    assert.ok(clients.every(item => item.style.display === 'block'));
    nodes.gridViewBtn.listeners.click();
    assert.equal(nodes.clientiContainer.classes.has('grid-view'), true);
});

test('Closing a package requires confirmation before form submission', () => {
    const context = vm.createContext({ window: { confirm: () => false }, document: { querySelectorAll: () => [] } });
    const script = fs.readFileSync(path.join(root, 'templates/cliente_dettaglio.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
    vm.runInContext(script, context);
    const form = { dataset: { pacchetto: 'Pacchetto prova' } };
    assert.equal(context.confermaChiusuraPacchetto(form), false);
    context.window.confirm = () => true;
    assert.equal(context.confermaChiusuraPacchetto(form), true);
});

function emailBookingContext() {
    const { context, nodes } = mainContext();
    for (const id of ['servizioSelect', 'pacchettoSelect', 'eventoRipetiSettimanale', 'eventoNumeroOccorrenze',
        'eventoData', 'eventoOraInizio', 'eventoOraFine', 'eventoNote', 'eventoOccupato', 'eventoInviaConfermaEmail',
        'btnSalvaEvento', 'eventoEmailMancanti', 'eventoEmailMancantiCampi']) nodes[id] = new Element();
    nodes.servizioSelect.value = '20'; nodes.eventoData.value = '2026-11-11';
    nodes.eventoOraInizio.value = '10:00'; nodes.eventoOraFine.value = '11:00';
    context.chiudiModal = () => {};
    context.aggiornaClientiSelezionati = () => {};
    context.console = { error() {} };
    vm.runInContext('calendar = {refetchEvents() {}};', context);
    return { context, nodes };
}

test('Missing emails render per person, preserve drafts and never appear for existing addresses', () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoEmailMancanti.hidden, false);
    const input = nodes['eventoEmailCliente-101'];
    assert.equal(input.type, 'email');
    input.value = 'mario@example.com'; input.listeners.input();
    vm.runInContext('clientiSelezionati.push({id: "202", nome: "Anna"});', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes['eventoEmailCliente-101'].value, 'mario@example.com');
    assert.equal(nodes.eventoEmailMancantiCampi.children.length, 2);
    assert.match(nodes.eventoEmailMancantiCampi.children[1].children[0].textContent, /Anna/);
    vm.runInContext('clientiSelezionati = [{id: "202", nome: "Anna", email: "anna@example.com"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoEmailMancanti.hidden, true);
    assert.equal(vm.runInContext('emailNuovoEvento.has("101")', context), false);
});

test('Both emails are saved to the right profiles before creating and confirming a couple appointment', async () => {
    const { context, nodes } = emailBookingContext();
    nodes.eventoInviaConfermaEmail.checked = true;
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}, {id: "202", nome: "Anna"}]; tuttiClienti = clientiSelezionati.map(c => ({...c})); emailNuovoEvento.set("101", " mario@example.com "); emailNuovoEvento.set("202", "anna@example.com");', context);
    const calls = [];
    context.fetchJsonOrThrow = async (url, options) => {
        const body = JSON.parse(options.body); calls.push({ url, body });
        if (url.endsWith('/conflitti')) return { count: 0 };
        if (url.endsWith('/email')) return { id: url.split('/')[3], email: body.email };
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.deepEqual(calls.map(call => call.url), ['/api/appuntamenti/conflitti', '/api/clienti/101/email', '/api/clienti/202/email', '/api/appuntamenti']);
    assert.equal(calls[1].body.email, 'mario@example.com');
    assert.equal(calls[2].body.email, 'anna@example.com');
    assert.deepEqual(calls[3].body.clienti_ids, ['101', '202']);
    assert.equal(calls[3].body.invia_conferma_email, true);
    assert.equal(vm.runInContext('tuttiClienti[0].email', context), 'mario@example.com');
    assert.equal(vm.runInContext('tuttiClienti[1].email', context), 'anna@example.com');
    assert.equal(nodes.btnSalvaEvento.disabled, false);
});

test('Invalid email blocks all writes and focuses the correct field', async () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}]; emailNuovoEvento.set("101", "non-valida");', context);
    context.aggiornaCampiEmailNuovoEvento();
    context.fetchJsonOrThrow = () => assert.fail('No request expected');
    await context.salvaEvento();
    assert.equal(nodes['eventoEmailCliente-101'].getAttribute('aria-invalid'), 'true');
    assert.equal(nodes['eventoEmailCliente-101'].focused, true);
    assert.equal(nodes.btnSalvaEvento.disabled, false);
});

test('Declining overlap warning does not save an email or create an appointment', async () => {
    const { context } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101"}]; emailNuovoEvento.set("101", "mario@example.com");', context);
    const calls = [];
    context.fetchJsonOrThrow = async url => { calls.push(url); return { count: 1 }; };
    await context.salvaEvento();
    assert.deepEqual(calls, ['/api/appuntamenti/conflitti']);
});

test('A partial profile-save failure stops booking and retries only the still missing email', async () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}, {id: "202", nome: "Anna"}]; emailNuovoEvento.set("101", "mario@example.com"); emailNuovoEvento.set("202", "anna@example.com");', context);
    const calls = [];
    let fail = true;
    context.fetchJsonOrThrow = async (url, options) => {
        calls.push(url);
        if (url.endsWith('/conflitti')) return { count: 0 };
        if (url.endsWith('/202/email') && fail) throw new Error('Errore di rete');
        if (url.endsWith('/email')) return { id: url.split('/')[3], email: JSON.parse(options.body).email };
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.equal(calls.includes('/api/appuntamenti'), false);
    assert.equal(vm.runInContext('clientiSelezionati[0].email', context), 'mario@example.com');
    assert.equal(nodes['eventoEmailCliente-202'].value, 'anna@example.com');
    assert.equal(nodes.btnSalvaEvento.disabled, false);
    fail = false;
    await context.salvaEvento();
    assert.equal(calls.filter(url => url.endsWith('/101/email')).length, 1);
    assert.equal(calls.filter(url => url.endsWith('/202/email')).length, 2);
    assert.equal(calls.filter(url => url === '/api/appuntamenti').length, 1);
});

test('Email can be saved without sending a confirmation, while empty inputs remain optional', async () => {
    const { context } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101"}, {id: "202"}]; emailNuovoEvento.set("101", "mario@example.com");', context);
    const calls = [];
    context.fetchJsonOrThrow = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith('/conflitti')) return { count: 0 };
        if (url.endsWith('/email')) return { id: '101', email: 'mario@example.com' };
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.equal(calls.filter(call => call.url.endsWith('/email')).length, 1);
    assert.equal(calls.at(-1).body.invia_conferma_email, false);
});

test('Occupied slots ignore email drafts entirely', async () => {
    const { context, nodes } = emailBookingContext();
    nodes.eventoOccupato.checked = true;
    nodes.eventoInviaConfermaEmail.checked = true;
    vm.runInContext('clientiSelezionati = [{id: "101"}]; emailNuovoEvento.set("101", "non-valida");', context);
    const calls = [];
    context.fetchJsonOrThrow = async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return { count: 0 }; };
    await context.salvaEvento();
    assert.equal(calls.some(call => call.url.endsWith('/email')), false);
    assert.deepEqual(calls.at(-1).body.clienti_ids, []);
    assert.equal(calls.at(-1).body.invia_conferma_email, false);
});

test('Reopening the appointment dialog clears unsaved email drafts', () => {
    const { context, nodes } = emailBookingContext();
    nodes.eventoModal = new Element();
    for (const fn of ['inizializzaRicercaClienti', 'sincronizzaCampiDataOraNuovoEvento', 'resetRicorrenzaEvento', 'resetSlotPersonalizzati', 'resetStatoOccupato']) context[fn] = () => {};
    vm.runInContext('selectedStart = "2026-11-11T10:00:00"; selectedEnd = "2026-11-11T11:00:00"; emailNuovoEvento.set("101", "non-salvata@example.com");', context);
    context.apriModal();
    assert.equal(vm.runInContext('emailNuovoEvento.size', context), 0);
});

test('Browser-autofilled emails are preserved and saved even without an input event', async () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    nodes['eventoEmailCliente-101'].value = ' mario@example.com ';
    vm.runInContext('clientiSelezionati.push({id: "202", nome: "Anna", email: "anna@example.com"});', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes['eventoEmailCliente-101'].value.trim(), 'mario@example.com');
    const calls = [];
    context.fetchJsonOrThrow = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        if (url.endsWith('/conflitti')) return { count: 0 };
        if (url.endsWith('/email')) return { id: '101', email: 'mario@example.com' };
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.equal(calls.find(call => call.url.endsWith('/email')).body.email, 'mario@example.com');
});

test('Rescheduling refreshes all session numbers, not just the dragged event', async () => {
    const { context } = mainContext();
    context.window.refreshed = 0;
    vm.runInContext('calendar = {refetchEvents() { window.refreshed++; }};', context);
    const calls = [];
    context.fetchJsonOrThrow = async url => { calls.push(url); return { count: 0 }; };
    await context.aggiornaOrario({ event: { id: '42', start: new Date('2026-11-11T10:00:00'), end: new Date('2026-11-11T11:00:00') } });
    assert.deepEqual(calls, ['/api/appuntamenti/conflitti', '/api/appuntamenti/42']);
    assert.equal(context.window.refreshed, 1);
});

test('Package summary ignores an older response when a fresher count has arrived', async () => {
    const { context, nodes } = mainContext();
    nodes.dashboardPacchettiCount = new Element();
    const pending = [];
    context.fetchJsonOrThrow = () => new Promise(resolve => pending.push(resolve));
    const older = context.aggiornaContatorePacchetti();
    const newer = context.aggiornaContatorePacchetti();
    pending[1]([{}, {}]); await newer;
    pending[0]([{}]); await older;
    assert.equal(nodes.dashboardPacchettiCount.textContent, '2');
});

function calendarTestEvent(props = {}) {
    return { id: '42', start: new Date('2026-11-11T10:00:00'), end: new Date('2026-11-11T11:00:00'),
        extendedProps: { clienti: 'Mario Rossi + Anna Bianchi', servizio: 'Ginnastica di coppia',
            numero_seduta: 3, sedute_totali: 10, stato: 'prenotato', ...props } };
}

test('Calendar cards show times, both full names and authoritative package numbering as plain text', () => {
    const { context } = mainContext();
    const event = calendarTestEvent();
    const card = context.renderCalendarEvent({ event }).domNodes[0];
    assert.match(card.children[0].textContent, /10:00.*11:00/);
    assert.equal(card.children[1].textContent, 'Mario Rossi + Anna Bianchi');
    assert.equal(card.children[2].textContent, 'Ginnastica di coppia');
    assert.equal(card.children[3].children[0].textContent, 'Seduta 3/10');
    const hostile = context.renderCalendarEvent({ event: calendarTestEvent({ clienti: '<img src=x onerror=alert(1)>' }) }).domNodes[0];
    assert.equal(hostile.children[1].innerHTML, '');
    assert.match(hostile.children[1].textContent, /<img/);
    assert.equal(context.calendarSessionLabel({ numero_seduta: 3 }), 'Seduta 3');
    assert.equal(context.calendarSessionLabel({ occupato: true, numero_seduta: 3 }), '');
});

test('Occupied and short events keep red identity, accessible summaries and compact layout', () => {
    const { context } = mainContext();
    const event = calendarTestEvent({ occupato: true, stato: 'occupato' });
    const el = new Element(); el.height = 28;
    context.mountCalendarEvent({ event, el });
    assert.equal(el.style['--calendar-event-accent'], '#b91c1c');
    assert.equal(el.classes.has('is-busy'), true);
    assert.equal(el.classes.has('is-tiny'), true);
    assert.equal(el.getAttribute('role'), 'button');
    assert.match(el.getAttribute('aria-label'), /Occupato/);
    assert.equal(context.renderCalendarEvent({ event }).domNodes[0].children.length, 2);
    assert.equal(context.renderCalendarEvent({ event: { display: 'background' } }), undefined);
});

test('Opening an appointment works on a phone and with the keyboard without sending emails', () => {
    const { context } = mainContext();
    context.window.matchMedia = () => ({ matches: true });
    let opened = 0;
    context.apriModificaModal = () => opened++;
    context.fetch = () => assert.fail('No send expected');
    const event = calendarTestEvent(); const el = new Element();
    context.openCalendarAppointment({ event });
    assert.equal(opened, 1);
    assert.equal(context.window.eventoSelezionato, event);
    context.mountCalendarEvent({ event, el });
    el.listeners.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(opened, 2);
});

test('Calendar errors are explicit, retryable and never marked as an empty successful agenda', async () => {
    const { context, nodes } = mainContext();
    for (const id of ['calendar', 'calendarRetry', 'calendarStatusText', 'calendarNew']) nodes[id] = new Element();
    context.fetchJsonOrThrow = async () => { throw new Error('private provider details'); };
    let failed = 0;
    await context.loadCalendarEvents({ startStr: 'a', endStr: 'b' }, () => assert.fail(), () => failed++);
    assert.equal(failed, 1);
    assert.equal(nodes.calendarRetry.hidden, false);
    assert.equal(nodes.calendarNew.disabled, true);
    assert.equal(nodes.calendar.classes.has('calendar-unavailable'), true);
    assert.match(nodes.calendarStatusText.textContent, /non è verificata/);
    context.fetchJsonOrThrow = async () => [];
    await context.loadCalendarEvents({ startStr: 'a', endStr: 'b' }, () => {}, () => assert.fail());
    assert.equal(nodes.calendarRetry.hidden, true);
    assert.equal(nodes.calendarNew.disabled, false);
    assert.equal(nodes.calendar.classes.has('calendar-unavailable'), false);
    assert.match(nodes.calendarStatusText.textContent, /Nessun appuntamento/);
    context.fetchJsonOrThrow = async () => ({ error: 'unexpected payload' });
    await context.loadCalendarEvents({ startStr: 'a', endStr: 'b' }, () => assert.fail(), () => failed++);
    assert.equal(failed, 2);
});

test('A stale calendar failure never overwrites a newer successful range', async () => {
    const { context, nodes } = mainContext();
    nodes.calendarStatusText = new Element(); nodes.calendarRetry = new Element();
    let rejectOld;
    context.fetchJsonOrThrow = () => new Promise((_, reject) => { rejectOld = reject; });
    const old = context.loadCalendarEvents({ startStr: 'a', endStr: 'b' }, () => {}, () => {});
    context.fetchJsonOrThrow = async () => [calendarTestEvent()];
    await context.loadCalendarEvents({ startStr: 'c', endStr: 'd' }, () => {}, () => assert.fail());
    rejectOld(new Error('late')); await old;
    assert.equal(nodes.calendarStatusText.textContent, '');
    assert.equal(nodes.calendarRetry.hidden, true);
});

test('Filter chips identify and remove one filter without clearing the others', () => {
    const { context, nodes } = mainContext();
    for (const id of ['calendarActiveFilters', 'calendarFilterCount', 'filtroStato', 'filtroServizio',
        'filtroCliente', 'filtroDataDa', 'filtroDataA', 'toggleFiltriCalendario']) nodes[id] = new Element();
    nodes.filtroStato.value = 'svolto'; nodes.filtroCliente.value = 'Mario';
    context.aggiornaFiltriCalendarioDaUI(false);
    assert.equal(nodes.calendarActiveFilters.children.length, 2);
    assert.match(nodes.calendarActiveFilters.children[0].textContent, /Svolto/);
    nodes.calendarActiveFilters.children[0].listeners.click();
    assert.equal(nodes.filtroStato.value, '');
    assert.equal(nodes.filtroCliente.value, 'Mario');
    assert.equal(nodes.calendarActiveFilters.children.length, 1);
    context.resetFiltriCalendario();
    assert.equal(nodes.calendarActiveFilters.children.length, 0);
    assert.equal(nodes.calendarFilterCount.hidden, true);
});

test('Toolbar changes dates and views, updates active state and creates only on a ready calendar', () => {
    const { context, nodes } = mainContext();
    for (const id of ['calendarTitle', 'calendarDate', 'calendarPrev', 'calendarNext', 'calendarToday',
        'calendarViewDay', 'calendarViewWeek', 'calendarNew', 'calendarRetry']) nodes[id] = new Element();
    const calls = [];
    context.window.testCalendar = { prev: () => calls.push('prev'), next: () => calls.push('next'), today: () => calls.push('today'),
        changeView: type => calls.push(type), gotoDate: date => calls.push(date), refetchEvents: () => calls.push('retry'),
        getDate: () => new Date('2026-11-11T12:00:00') };
    vm.runInContext('calendar = window.testCalendar;', context);
    context.apriModal = () => calls.push('create');
    context.initializeCalendarControls();
    nodes.calendarPrev.listeners.click(); nodes.calendarNext.listeners.click(); nodes.calendarToday.listeners.click();
    nodes.calendarViewDay.listeners.click(); nodes.calendarViewWeek.listeners.click(); nodes.calendarRetry.listeners.click();
    nodes.calendarDate.listeners.change({ target: { value: '2026-11-12', validity: { valid: true } } });
    context.updateCalendarToolbar({ view: { title: '11 novembre', type: 'timeGridDay', calendar: context.window.testCalendar } });
    assert.equal(nodes.calendarTitle.textContent, '11 novembre');
    assert.equal(nodes.calendarDate.value, '2026-11-11');
    assert.equal(nodes.calendarViewDay.getAttribute('aria-pressed'), 'true');
    assert.equal(nodes.calendarViewWeek.getAttribute('aria-pressed'), 'false');
    nodes.calendarNew.listeners.click();
    context.setCalendarReadState('error'); nodes.calendarNew.listeners.click();
    assert.deepEqual(calls, ['prev', 'next', 'today', 'timeGridDay', 'timeGridWeek', 'retry', '2026-11-12', 'create']);
});

test('Preview reads per-person email status without claiming delivery and ignores responses after closing', async () => {
    const { context, nodes } = mainContext();
    const event = calendarTestEvent(); const el = new Element();
    context.fetchJsonOrThrow = async (url, options) => {
        assert.equal(url, '/api/appuntamenti/42/conferme'); assert.equal(options.method, undefined);
        return { destinatari: [{ nome: 'Mario', has_email: true, status: 'sent' }, { nome: 'Anna', has_email: false }] };
    };
    await context.showCalendarPreview({ event, el });
    let preview = nodes.calendarPreview;
    assert.match(preview.children.at(-1).textContent, /consegna non verificata/);
    assert.match(preview.children.at(-1).textContent, /Anna: Indirizzo mancante/);
    assert.equal(el.getAttribute('aria-describedby'), 'calendarPreview');
    let resolve;
    context.fetchJsonOrThrow = () => new Promise(done => { resolve = done; });
    const pending = context.showCalendarPreview({ event, el });
    context.hideCalendarPreview();
    resolve({ destinatari: [{ nome: 'Old person', has_email: true, status: 'sent' }] }); await pending;
    assert.equal(preview.hidden, true);
    assert.doesNotMatch(preview.children.at(-1).textContent, /Old person/);
    assert.equal(el.getAttribute('aria-describedby'), undefined);
});

test('Day view weekly summary reads the whole week and ignores older responses', async () => {
    const { context, nodes } = mainContext();
    nodes.weekCount = new Element(); nodes.weekRangeLabel = new Element();
    context.window.testCalendar = { getDate: () => new Date('2026-10-23T12:00:00') };
    vm.runInContext('calendar = window.testCalendar;', context);
    const requests = [];
    context.fetchJsonOrThrow = url => new Promise(resolve => requests.push({ url, resolve }));
    const old = context.updateCalendarWeekSummary();
    const current = context.updateCalendarWeekSummary();
    const url = new URL(requests[0].url, 'http://localhost');
    assert.match(url.searchParams.get('start'), /^2026-10-19T00:00:00$/);
    assert.match(url.searchParams.get('end'), /^2026-10-26T00:00:00$/);
    requests[1].resolve([{}, {}, {}]); await current;
    requests[0].resolve([{}]); await old;
    assert.equal(nodes.weekCount.textContent, '3');
    assert.match(nodes.weekRangeLabel.textContent, /25/);
});

test('Rome weeks keep Monday midnight boundaries over daylight saving changes', () => {
    const originalTZ = process.env.TZ;
    process.env.TZ = 'Europe/Rome';
    try {
        const { context } = mainContext();
        for (const date of ['2026-10-23T12:00:00', '2026-03-27T12:00:00']) {
            const range = context.getSettimanaRange(new Date(date));
            assert.equal(range.monday.getDay(), 1);
            assert.equal(range.sundayExclusive.getDay(), 1);
            assert.equal(range.sundayExclusive.getHours(), 0);
        }
    } finally {
        if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ;
    }
});

test('Calendar configuration starts phones in day view with taps enabled and accidental dragging disabled', () => {
    const source = fs.readFileSync(path.join(root, 'static/main.js'), 'utf8');
    const start = source.indexOf('new FullCalendar.Calendar(calendarEl, {') + 'new FullCalendar.Calendar(calendarEl, '.length;
    const end = source.indexOf('    });\n\n    calendar.render();', start);
    assert.ok(end > start);
    for (const mobile of [true, false]) {
        const { context } = mainContext();
        vm.runInContext(`const mobileMode = ${mobile}; window.calendarOptions = ${source.slice(start, end)} };`, context);
        const options = context.window.calendarOptions;
        assert.equal(options.initialView, mobile ? 'timeGridDay' : 'timeGridWeek');
        assert.equal(options.selectable, !mobile);
        assert.equal(options.editable, !mobile);
        assert.equal(options.eventClick, context.openCalendarAppointment);
        assert.equal(options.headerToolbar, false);
        context.setCalendarReadState('error');
        assert.equal(options.selectAllow(), false);
        assert.equal(options.eventAllow(), false);
    }
});

test('Mobile day and week layouts keep their own sizing, scroll hint and horizontal position', () => {
    const { context, nodes } = mainContext();
    nodes.calendar = new Element(); nodes.mobileCalendarHint = new Element();
    context.window.matchMedia = () => ({ matches: true });
    context.updateMobileCalendarLayout('timeGridWeek');
    assert.equal(nodes.calendar.classes.has('is-mobile-week'), true);
    assert.match(nodes.mobileCalendarHint.textContent, /Scorri a destra o sinistra/);
    nodes.calendar.scrollLeft = 300;
    context.updateMobileCalendarLayout('timeGridWeek');
    assert.equal(nodes.calendar.scrollLeft, 300, 'Resize must preserve the viewed days');
    context.updateMobileCalendarLayout('timeGridDay');
    assert.equal(nodes.calendar.scrollLeft, 0);
    assert.equal(nodes.calendar.classes.has('is-mobile-week'), false);
    assert.equal(nodes.calendar.classes.has('is-mobile-day'), true);
    assert.match(nodes.mobileCalendarHint.textContent, /dettagli e modifiche/);
    context.window.matchMedia = () => ({ matches: false });
    context.updateMobileCalendarLayout('timeGridDay');
    assert.equal(nodes.calendar.classes.has('is-mobile-day'), false);
});

function appointmentDetailsContext() {
    const { context, nodes } = mainContext();
    for (const id of ['editAppointmentTitle', 'editAppointmentMeta', 'editAppointmentWhen', 'editAppointmentState',
        'dataModifica', 'oraInizioModifica', 'oraFineModifica', 'noteModifica', 'modificaModal',
        'whatsappDestinatari', 'confermeEmailSection', 'closeEditAppointment', 'btnSalvaModifiche']) nodes[id] = new Element();
    const card = new Element(); card.scrollTop = 400;
    nodes.modificaModal.querySelector = () => card;
    context.window.matchMedia = () => ({ matches: true });
    context.caricaConfermeEmail = () => {};
    context.fetch = () => assert.fail('Opening details must never write or send');
    return { context, nodes, card };
}

test('A phone tap opens real editable details for both people, focuses Close and restores scrolling on dismissal', () => {
    const { context, nodes, card } = appointmentDetailsContext();
    const event = calendarTestEvent({ clienti_ids: ['101', '202'], note: 'Nota già salvata' });
    const anchor = new Element(); anchor.isConnected = true;
    context.openCalendarAppointment({ event, el: anchor, jsEvent: { preventDefault() {} } });
    assert.equal(nodes.modificaModal.style.display, 'block');
    assert.equal(context.document.body.classes.has('appointment-detail-open'), true);
    assert.equal(nodes.closeEditAppointment.focused, true);
    assert.equal(card.scrollTop, 0);
    assert.match(nodes.editAppointmentTitle.children[0].textContent, /Mario Rossi/);
    assert.match(nodes.editAppointmentTitle.children[2].textContent, /Anna Bianchi/);
    assert.match(nodes.editAppointmentMeta.textContent, /Seduta 3\/10/);
    assert.match(nodes.editAppointmentWhen.textContent, /10:00.*11:00.*60 min/);
    assert.equal(nodes.editAppointmentState.textContent, 'Prenotato');
    assert.equal(nodes.dataModifica.value, '2026-11-11');
    assert.equal(nodes.oraInizioModifica.value, '10:00');
    assert.equal(nodes.oraFineModifica.value, '11:00');
    assert.equal(nodes.noteModifica.value, 'Nota già salvata');
    context.chiudiModificaModal();
    assert.equal(nodes.modificaModal.style.display, 'none');
    assert.equal(context.document.body.classes.has('appointment-detail-open'), false);
    assert.equal(anchor.focused, true);
});

test('Occupied slots open editable details without email queries; background slots are not appointments', () => {
    const { context, nodes } = appointmentDetailsContext();
    context.caricaConfermeEmail = () => assert.fail('Occupied slots have no confirmation recipients');
    context.openCalendarAppointment({ event: calendarTestEvent({ occupato: true, stato: 'occupato' }) });
    assert.equal(nodes.editAppointmentTitle.textContent, 'Occupato');
    assert.equal(nodes.confermeEmailSection.hidden, true);
    assert.equal(nodes.editAppointmentMeta.textContent, 'Slot non disponibile');
    context.chiudiModificaModal();
    context.openCalendarAppointment({ event: { display: 'background' } });
    assert.equal(nodes.modificaModal.style.display, 'none');
});

test('Phone detail edits use the existing save path and never send email automatically', async () => {
    const { context, nodes } = appointmentDetailsContext();
    context.openCalendarAppointment({ event: calendarTestEvent() });
    nodes.noteModifica.value = 'Nota aggiornata';
    const requests = [];
    context.fetchJsonOrThrow = async (url, options) => { requests.push({ url, method: options.method, body: JSON.parse(options.body) }); return { success: true }; };
    context.window.refreshed = false;
    vm.runInContext('calendar = { refetchEvents() { window.refreshed = true; } };', context);
    await context.salvaModifiche();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/appuntamenti/42');
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].body.note, 'Nota aggiornata');
    assert.equal(requests[0].body.invia_conferma_email, undefined);
    assert.equal(context.window.refreshed, true);
    assert.equal(nodes.modificaModal.style.display, 'none');
});
