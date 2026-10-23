const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');

class Element {
    constructor(tag = 'div') {
        this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {};
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
}

function mainContext() {
    const nodes = {};
    const document = {
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
    const context = vm.createContext({ document, window: { addEventListener() {}, confirm: () => false }, console,
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
