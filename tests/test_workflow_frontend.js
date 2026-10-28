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

test('Selecting a client with an address automatically enables confirmation and removing them clears the default', () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    vm.runInContext('clientiSelezionati = [{id: "202", nome: "Anna", email: " anna@example.com "}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
    vm.runInContext('clientiSelezionati = [];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
});

test('Couple bookings automatically request confirmation with one or both available addresses', async () => {
    for (const addresses of [1, 2]) {
        const { context, nodes } = emailBookingContext();
        nodes.eventoRiepilogo = new Element(); nodes.eventoRiepilogoEmail = new Element();
        vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario", email: "mario@example.com"}, {id: "202", nome: "Anna"}];', context);
        if (addresses === 2) vm.runInContext('clientiSelezionati[1].email = "anna@example.com";', context);
        context.aggiornaCampiEmailNuovoEvento();
        context.aggiornaRiepilogoNuovoEvento();
        assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
        assert.match(nodes.eventoRiepilogoEmail.textContent, new RegExp(`per ${addresses} person`));
        const calls = [];
        context.fetchJsonOrThrow = async (url, options) => {
            calls.push({ url, body: JSON.parse(options.body) });
            return url.endsWith('/conflitti') ? { count: 0 } : { created_count: 1 };
        };
        await context.salvaEvento();
        assert.deepEqual(calls.at(-1).body.clienti_ids, ['101', '202']);
        assert.equal(calls.at(-1).body.invia_conferma_email, true);
        assert.equal(calls.some(call => call.url.endsWith('/email')), false);
    }
});

test('Manual confirmation opt-out survives selection changes, rerenders, save errors and retry', async () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", email: "mario@example.com"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
    nodes.eventoInviaConfermaEmail.checked = false;
    nodes.eventoInviaConfermaEmail.listeners.change();
    vm.runInContext('clientiSelezionati.push({id: "202", email: "anna@example.com"});', context);
    context.aggiornaCampiEmailNuovoEvento(); context.aggiornaRiepilogoNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    vm.runInContext('clientiSelezionati = [clientiSelezionati[1]];', context);
    context.aggiornaCampiEmailNuovoEvento();
    const requests = [];
    let fail = true;
    context.fetchJsonOrThrow = async (url, options) => {
        if (url.endsWith('/conflitti')) return { count: 0 };
        requests.push(JSON.parse(options.body));
        if (fail) throw new Error('Errore di rete');
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    assert.equal(nodes.btnSalvaEvento.disabled, false);
    fail = false;
    await context.salvaEvento();
    assert.equal(requests.length, 2);
    assert.ok(requests.every(body => body.invia_conferma_email === false));
});

test('Checkbox input records opt-out before the bubbling modal summary and subsequent change event', async () => {
    const { context, nodes } = emailBookingContext();
    nodes.eventoModal = new Element();
    nodes.eventoRiepilogo = new Element(); nodes.eventoRiepilogoEmail = new Element();
    vm.runInContext('clientiSelezionati = [{id: "101", email: "mario@example.com"}];', context);
    context.inizializzaRiepilogoNuovoEvento();
    context.aggiornaCampiEmailNuovoEvento();
    const checkbox = nodes.eventoInviaConfermaEmail;
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.listeners.input();
    nodes.eventoModal.listeners.input();
    assert.equal(checkbox.checked, false);
    checkbox.listeners.change();
    nodes.eventoModal.listeners.change();
    assert.equal(checkbox.checked, false);
    assert.equal(nodes.eventoRiepilogoEmail.textContent, 'Conferma email non richiesta');
    const requests = [];
    context.fetchJsonOrThrow = async (url, options) => {
        if (url.endsWith('/conflitti')) return { count: 0 };
        requests.push(JSON.parse(options.body));
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].invia_conferma_email, false);
});

test('Occupied mode suppresses automatic confirmation and preserves the choice when returning to a booking', () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", email: "mario@example.com"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
    nodes.eventoOccupato.checked = true; context.sincronizzaStatoOccupatoUI();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    assert.equal(nodes.eventoInviaConfermaEmail.disabled, true);
    nodes.eventoOccupato.checked = false; context.sincronizzaStatoOccupatoUI();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
    assert.equal(nodes.eventoInviaConfermaEmail.disabled, false);
    nodes.eventoInviaConfermaEmail.checked = false; nodes.eventoInviaConfermaEmail.listeners.change();
    nodes.eventoOccupato.checked = true; context.sincronizzaStatoOccupatoUI();
    nodes.eventoOccupato.checked = false; context.sincronizzaStatoOccupatoUI();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
});

test('Opening a new appointment discards the previous booking opt-out', () => {
    const { context, nodes } = emailBookingContext();
    nodes.eventoModal = new Element();
    for (const fn of ['inizializzaRicercaClienti', 'sincronizzaCampiDataOraNuovoEvento', 'resetRicorrenzaEvento', 'resetSlotPersonalizzati']) context[fn] = () => {};
    vm.runInContext('selectedStart = "2026-11-11T10:00:00"; selectedEnd = "2026-11-11T11:00:00"; clientiSelezionati = [{id: "101", email: "mario@example.com"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    nodes.eventoInviaConfermaEmail.checked = false; nodes.eventoInviaConfermaEmail.listeners.change();
    context.apriModal();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    assert.equal(vm.runInContext('sceltaManualeConfermaEmail', context), null);
    vm.runInContext('clientiSelezionati = [{id: "202", email: "anna@example.com"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
});

test('A valid inline address enables confirmation automatically, but an explicit opt-out is retained while typing', () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    const input = nodes['eventoEmailCliente-101'];
    input.value = 'non-valida'; input.listeners.input();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    input.value = 'mario@example.com'; input.listeners.input();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, true);
    input.value = ''; input.listeners.change();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    input.value = 'mario@example.com'; input.listeners.change();
    nodes.eventoInviaConfermaEmail.checked = false; nodes.eventoInviaConfermaEmail.listeners.change();
    input.value = 'mario.nuovo@example.com'; input.listeners.input();
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
});

test('Save detects an autofilled address without input events and automatically requests its confirmation', async () => {
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101", nome: "Mario"}];', context);
    context.aggiornaCampiEmailNuovoEvento();
    assert.equal(nodes.eventoInviaConfermaEmail.checked, false);
    nodes['eventoEmailCliente-101'].value = ' mario@example.com ';
    const calls = [];
    context.fetchJsonOrThrow = async (url, options) => {
        const body = JSON.parse(options.body); calls.push({ url, body });
        if (url.endsWith('/conflitti')) return { count: 0 };
        if (url.endsWith('/email')) return { id: '101', email: body.email };
        return { created_count: 1 };
    };
    await context.salvaEvento();
    assert.deepEqual(calls.map(call => call.url), ['/api/appuntamenti/conflitti', '/api/clienti/101/email', '/api/appuntamenti']);
    assert.equal(calls[1].body.email, 'mario@example.com');
    assert.equal(calls[2].body.invia_conferma_email, true);
});

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
    const { context, nodes } = emailBookingContext();
    vm.runInContext('clientiSelezionati = [{id: "101"}, {id: "202"}]; emailNuovoEvento.set("101", "mario@example.com");', context);
    context.inizializzaConfermaEmailAutomatica();
    nodes.eventoInviaConfermaEmail.checked = false;
    nodes.eventoInviaConfermaEmail.listeners.change();
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

test('Login password visibility is optional, accessible and never changes or submits credentials', () => {
    const password = new Element('input'); password.type = 'password'; password.value = 'a local test value';
    const toggle = new Element('button'); toggle.hidden = true;
    const error = new Element();
    const nodes = { loginPassword: password, loginPasswordToggle: toggle, loginError: error };
    const context = vm.createContext({ document: { getElementById: id => nodes[id] || null } });
    const script = fs.readFileSync(path.join(root, 'static/login.js'), 'utf8');
    vm.runInContext(script, context);
    assert.equal(toggle.hidden, false);
    assert.equal(error.focused, true);
    toggle.listeners.click();
    assert.equal(password.type, 'text');
    assert.equal(toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(toggle.getAttribute('aria-label'), 'Nascondi password');
    toggle.listeners.click();
    assert.equal(password.type, 'password');
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.equal(toggle.getAttribute('aria-label'), 'Mostra password');
    assert.equal(password.value, 'a local test value');
    vm.runInContext(script, vm.createContext({ document: { getElementById: () => null } }));
});

test('Operational totals exclude Check, occupied and cancelled while retaining ordinary couple sessions', async () => {
    const { context, nodes } = mainContext();
    nodes.weekCount = new Element(); nodes.weekRangeLabel = new Element();
    const events = [calendarTestEvent(), calendarTestEvent({ servizio: ' Check ' }), calendarTestEvent({ servizio: 'cHeCk' }),
        calendarTestEvent({ stato: 'occupato' }), calendarTestEvent({ stato: 'annullato' }), calendarTestEvent({ stato: 'svolto' })];
    assert.equal(events.filter(context.countedStudioAppointment).length, 2);
    assert.equal(context.countedStudioAppointment({ display: 'inverse-background' }), false);
    context.window.testCalendar = { getDate: () => new Date('2026-10-26T12:00:00') };
    vm.runInContext('calendar = window.testCalendar; filtriCalendario.cliente = "filtered-out"; filtriCalendario.stato = "occupato";', context);
    context.fetchJsonOrThrow = async url => {
        assert.equal(new URL(url, 'http://localhost').searchParams.has('cliente'), false);
        assert.equal(new URL(url, 'http://localhost').searchParams.has('stato'), false);
        return events;
    };
    await context.updateCalendarWeekSummary();
    assert.equal(nodes.weekCount.textContent, '2');
});

function nextAppointmentContext() {
    const { context, nodes } = mainContext();
    for (const id of ['nextAppointmentOpen', 'nextAppointmentStatus', 'nextAppointmentRetry', 'nextAppointmentTime',
        'nextAppointmentDate', 'nextAppointmentTiming', 'nextAppointmentClient', 'nextAppointmentService', 'nextAppointmentSession']) nodes[id] = new Element();
    return { context, nodes };
}

test('Next appointment shows both people, time and session and opens details outside the visible calendar', async () => {
    const { context, nodes } = nextAppointmentContext();
    const event = calendarTestEvent();
    context.fetchJsonOrThrow = async url => {
        assert.equal(url, '/api/prossimo_appuntamento');
        return { appuntamento: event, ora_studio: '2026-11-11T09:40:00' };
    };
    await context.updateNextAppointment();
    assert.equal(nodes.nextAppointmentClient.textContent, 'Mario Rossi + Anna Bianchi');
    assert.equal(nodes.nextAppointmentTime.textContent, '10:00');
    assert.equal(nodes.nextAppointmentTiming.textContent, 'Tra 20 min');
    assert.equal(nodes.nextAppointmentSession.textContent, 'Seduta 3/10');
    assert.equal(nodes.nextAppointmentOpen.disabled, false);
    context.apriModificaModal = () => {};
    context.openNextAppointment();
    assert.equal(context.window.eventoSelezionato.id, '42');
    assert.equal(context.window.eventoSelezionato.start.getHours(), 10);
});

test('Next appointment handles ongoing, empty, error and out-of-order reads without showing stale data', async () => {
    const { context, nodes } = nextAppointmentContext();
    let resolveOld;
    context.fetchJsonOrThrow = () => new Promise(resolve => { resolveOld = resolve; });
    const old = context.updateNextAppointment();
    context.fetchJsonOrThrow = async () => ({ appuntamento: calendarTestEvent(), ora_studio: '2026-11-11T10:20:00' });
    await context.updateNextAppointment();
    assert.equal(nodes.nextAppointmentTiming.textContent, 'In corso');
    resolveOld({ appuntamento: null }); await old;
    assert.equal(nodes.nextAppointmentOpen.disabled, false);
    context.fetchJsonOrThrow = async () => ({ appuntamento: null });
    await context.updateNextAppointment();
    assert.equal(nodes.nextAppointmentOpen.disabled, true);
    assert.equal(nodes.nextAppointmentService.textContent.includes('non contiene'), true);
    context.apriModificaModal = () => assert.fail('No stale event to open');
    context.openNextAppointment();
    context.fetchJsonOrThrow = async () => { throw new Error('network'); };
    await context.updateNextAppointment();
    assert.equal(nodes.nextAppointmentClient.textContent, 'Agenda non aggiornata');
    assert.equal(nodes.nextAppointmentRetry.hidden, false);
    assert.equal(nodes.nextAppointmentTime.textContent, '—');
    context.fetchJsonOrThrow = async () => ({});
    await context.updateNextAppointment();
    assert.equal(nodes.nextAppointmentClient.textContent, 'Agenda non aggiornata');
});

test('Daily summary uses the studio date and a failed read is not presented as zero appointments', async () => {
    const { context, nodes } = mainContext();
    nodes.dayCount = new Element(); nodes.dayLabel = new Element();
    context.fetchJsonOrThrow = async () => ({ totale: 4, data: '2026-10-26' });
    await context.updateDailySummary();
    assert.equal(nodes.dayCount.textContent, '4');
    assert.match(nodes.dayLabel.textContent, /26/);
    context.fetchJsonOrThrow = async () => { throw new Error('network'); };
    await context.updateDailySummary();
    assert.equal(nodes.dayCount.textContent, '—');
    context.fetchJsonOrThrow = async () => ({ totale: null });
    await context.updateDailySummary();
    assert.equal(nodes.dayCount.textContent, '—');
});

function popupDeferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function deletionPopupContext() {
    const { context, nodes } = mainContext();
    nodes.btnEliminaEvento = new Element('button');
    context.window.eventoSelezionato = calendarTestEvent();
    context.window.closeCalls = 0;
    context.window.refetchCalls = 0;
    context.chiudiModificaModal = () => { context.window.closeCalls++; };
    context.console = { error() {} };
    vm.runInContext('calendar = { refetchEvents() { window.refetchCalls++; } };', context);
    return { context, nodes };
}

test('Cancelling the styled delete confirmation performs no DELETE and leaves the edit controls usable', async () => {
    const { context, nodes } = deletionPopupContext();
    const prompts = [];
    context.mostraConferma = async options => { prompts.push(options); return false; };
    context.fetchJsonOrThrow = () => assert.fail('Cancelled deletion must never reach the API');
    await context.eliminaEvento();
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].pericolosa, true);
    assert.equal(nodes.btnEliminaEvento.disabled, false);
    assert.equal(context.window.closeCalls, 0);
    assert.equal(context.window.refetchCalls, 0);
});

test('Delete is guarded during both the custom confirmation and the network request', async () => {
    const { context, nodes } = deletionPopupContext();
    const decision = popupDeferred();
    const request = popupDeferred();
    const calls = [];
    let prompts = 0;
    context.mostraConferma = () => { prompts++; return decision.promise; };
    context.fetchJsonOrThrow = (url, options) => { calls.push({ url, method: options.method }); return request.promise; };
    const pending = context.eliminaEvento();
    await context.eliminaEvento();
    assert.equal(prompts, 1);
    assert.equal(calls.length, 0);
    decision.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(calls, [{ url: '/api/appuntamenti/42', method: 'DELETE' }]);
    await context.eliminaEvento();
    assert.equal(calls.length, 1);
    request.resolve({ success: true });
    await pending;
    assert.equal(nodes.btnEliminaEvento.disabled, false);
    assert.equal(context.window.closeCalls, 1);
    assert.equal(context.window.refetchCalls, 1);
});

test('Changing appointments while the delete dialog is open aborts the stale deletion', async () => {
    const { context, nodes } = deletionPopupContext();
    const decision = popupDeferred();
    context.mostraConferma = () => decision.promise;
    context.fetchJsonOrThrow = () => assert.fail('A stale dialog must not delete either appointment');
    const pending = context.eliminaEvento();
    context.window.eventoSelezionato = { ...calendarTestEvent(), id: '43' };
    decision.resolve(true);
    await pending;
    assert.equal(nodes.btnEliminaEvento.disabled, false);
    assert.equal(context.window.closeCalls, 0);
});

test('A completed deletion refreshes the calendar without closing a subsequently selected appointment', async () => {
    const { context } = deletionPopupContext();
    const request = popupDeferred();
    const started = popupDeferred();
    const calls = [];
    context.mostraConferma = async () => true;
    context.fetchJsonOrThrow = (url, options) => {
        calls.push({ url, method: options.method });
        started.resolve();
        return request.promise;
    };
    const pending = context.eliminaEvento();
    await started.promise;
    context.window.eventoSelezionato = { ...calendarTestEvent(), id: '43' };
    request.resolve({ success: true });
    await pending;
    assert.deepEqual(calls, [{ url: '/api/appuntamenti/42', method: 'DELETE' }]);
    assert.equal(context.window.eventoSelezionato.id, '43');
    assert.equal(context.window.closeCalls, 0);
    assert.equal(context.window.refetchCalls, 1);
});

test('A failed deletion keeps the appointment open and unlocks the delete button for a retry', async () => {
    const { context, nodes } = deletionPopupContext();
    const notices = [];
    context.mostraConferma = async () => true;
    context.mostraToast = (message, type) => notices.push({ message, type });
    context.fetchJsonOrThrow = async () => { throw new Error('Eliminazione simulata non riuscita'); };
    await context.eliminaEvento();
    assert.equal(nodes.btnEliminaEvento.disabled, false);
    assert.equal(context.window.closeCalls, 0);
    assert.equal(context.window.refetchCalls, 0);
    assert.equal(notices.at(-1).type, 'error');
    assert.match(notices.at(-1).message, /non riuscita/);
});

async function emailRetryPopupContext(status = 'unknown') {
    const { context, nodes } = mainContext();
    nodes.confermeEmailList = new Element();
    context.window.eventoSelezionato = calendarTestEvent();
    context.console = { error() {} };
    const posts = [];
    const reads = [];
    const persona = { cliente_id: '101', nome: 'Mario Test', status, has_email: true, can_send: true };
    const state = { post: async () => ({ email_confirmation: { requested: true, sent_count: 1 } }) };
    context.fetchJsonOrThrow = (url, options = {}) => {
        if (options.method === 'POST') {
            posts.push({ url, body: JSON.parse(options.body) });
            return state.post();
        }
        reads.push(url);
        return Promise.resolve({ destinatari: [persona] });
    };
    await context.caricaConfermeEmail('42');
    const retry = () => nodes.confermeEmailList.children[0].children.find(child => child.tag === 'button');
    return { context, nodes, posts, reads, state, retry };
}

test('Cancelling an uncertain-email dialog preserves its duplicate warning and sends no email', async () => {
    const { context, posts, retry } = await emailRetryPopupContext('unknown');
    const prompts = [];
    context.mostraConferma = async options => { prompts.push(options); return false; };
    await retry().listeners.click();
    assert.equal(prompts.length, 1);
    assert.match(prompts[0].messaggio, /già partita|già inviata/i);
    assert.match(prompts[0].messaggio, /duplic/i);
    assert.equal(posts.length, 0);
    assert.equal(retry().disabled, false);
});

test('Uncertain-email retry keeps the explicit flag and prevents duplicate clicks while confirming or sending', async () => {
    const { context, posts, state, retry } = await emailRetryPopupContext('unknown');
    const decision = popupDeferred();
    const request = popupDeferred();
    let prompts = 0;
    context.mostraConferma = () => { prompts++; return decision.promise; };
    state.post = () => request.promise;
    const originalButton = retry();
    const pending = originalButton.listeners.click();
    await originalButton.listeners.click();
    assert.equal(prompts, 1);
    assert.equal(posts.length, 0);
    decision.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    await originalButton.listeners.click();
    assert.deepEqual(posts, [{ url: '/api/appuntamenti/42/conferme', body: { cliente_id: '101', conferma_esito_incerto: true } }]);
    request.resolve({ email_confirmation: { requested: true, sent_count: 1 } });
    await pending;
    assert.equal(retry().disabled, false);
});

test('An email confirmation accepted after changing appointments does not send a stale request', async () => {
    const { context, posts, retry } = await emailRetryPopupContext();
    const decision = popupDeferred();
    context.mostraConferma = () => decision.promise;
    const pending = retry().listeners.click();
    context.window.eventoSelezionato = { ...calendarTestEvent(), id: '43' };
    decision.resolve(true);
    await pending;
    assert.equal(posts.length, 0);
});

test('An in-flight email result never overwrites the newly selected appointment confirmation list', async () => {
    const { context, nodes, posts, reads, state, retry } = await emailRetryPopupContext();
    const request = popupDeferred();
    const started = popupDeferred();
    context.mostraConferma = async () => true;
    state.post = () => { started.resolve(); return request.promise; };
    const pending = retry().listeners.click();
    await started.promise;
    assert.equal(posts.length, 1);
    context.window.eventoSelezionato = { ...calendarTestEvent(), id: '43' };
    nodes.confermeEmailList.textContent = 'Stato del nuovo appuntamento';
    request.resolve({ email_confirmation: { requested: true, sent_count: 1 } });
    await pending;
    assert.equal(reads.length, 1);
    assert.equal(nodes.confermeEmailList.textContent, 'Stato del nuovo appuntamento');
});

test('Untracked-email warning remains distinct and a failed send restores a usable retry', async () => {
    const { context, posts, state, retry } = await emailRetryPopupContext('untracked');
    const prompts = [];
    const notices = [];
    context.mostraConferma = async options => { prompts.push(options); return true; };
    context.mostraToast = (message, type) => notices.push({ message, type });
    state.post = async () => { throw new Error('Invio simulato non riuscito'); };
    await retry().listeners.click();
    assert.match(prompts[0].messaggio, /storico/i);
    assert.deepEqual(posts[0].body, { cliente_id: '101', conferma_esito_incerto: false });
    assert.equal(notices.at(-1).type, 'error');
    assert.equal(retry().disabled, false);
});

function popupComponentsContext() {
    const nodes = {};
    const windowListeners = {};
    const document = { activeElement: null };
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    class PopupElement extends Element {
        constructor(tag = 'div') { super(tag); this.isConnected = false; this.open = false; this.focusCalls = 0; }
        append(...items) { items.forEach(item => this.appendChild(item)); }
        appendChild(item) {
            item.parentElement = this;
            item.isConnected = this.isConnected;
            this.children.push(item);
            return item;
        }
        get firstElementChild() { return this.children[0] || null; }
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this);
            this.parentElement = null;
            this.isConnected = false;
        }
        removeEventListener(name, listener) { if (this.listeners[name] === listener) delete this.listeners[name]; }
        contains(target) { return this === target || this.children.some(child => child.contains?.(target)); }
        focus() { this.focused = true; this.focusCalls++; document.activeElement = this; }
        showModal() { this.open = true; }
        close() { this.open = false; this.listeners.close?.({ target: this }); }
    }
    document.body = new PopupElement('body'); document.body.isConnected = true;
    document.getElementById = id => nodes[id] || null;
    document.querySelectorAll = () => [];
    document.addEventListener = () => {};
    document.createTextNode = text => ({ textContent: text });
    document.createElement = tag => {
        const element = new PopupElement(tag);
        Object.defineProperty(element, 'id', { get() { return this._id; }, set(value) { this._id = value; nodes[value] = this; } });
        return element;
    };
    const context = vm.createContext({ document, console,
        window: { addEventListener: (name, listener) => { (windowListeners[name] ||= []).push(listener); }, confirm: () => false,
            matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800 },
        requestAnimationFrame: fn => fn(), URLSearchParams,
        Date: class extends Date { static now() { return now; } },
        setTimeout: (fn, delay = 0) => { const id = ++timerId; timers.set(id, { at: now + Number(delay), fn }); return id; },
        clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'static/main.js'), 'utf8'), context);
    for (const id of ['appConfirmDialog', 'appConfirmTitle', 'appConfirmMessage', 'appConfirmAccept', 'appConfirmCancel']) {
        const element = document.createElement(id === 'appConfirmDialog' ? 'dialog' : id.endsWith('Accept') || id.endsWith('Cancel') ? 'button' : 'div');
        element.id = id;
        document.body.appendChild(element);
    }
    const trigger = document.createElement('button'); document.body.appendChild(trigger); document.activeElement = trigger;
    const tick = milliseconds => {
        const target = now + milliseconds;
        let iterations = 0;
        while (true) {
            const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            assert.ok(++iterations < 1000, 'Timer loop must terminate');
            now = due[1].at; timers.delete(due[0]); due[1].fn();
        }
        now = target;
    };
    return { context, nodes, trigger, tick, timers, windowListeners };
}

test('Styled confirmation renders literal text, focuses Cancel, approves once and cleans all listeners', async () => {
    const { context, nodes, trigger } = popupComponentsContext();
    const title = '<img src=x onerror=alert(1)>';
    const message = '<script>non eseguire</script>';
    const pending = context.mostraConferma({ titolo: title, messaggio: message, conferma: 'Elimina', pericolosa: true });
    assert.equal(nodes.appConfirmTitle.textContent, title);
    assert.equal(nodes.appConfirmMessage.textContent, message);
    assert.equal(nodes.appConfirmTitle.innerHTML, '');
    assert.equal(nodes.appConfirmMessage.innerHTML, '');
    assert.equal(nodes.appConfirmAccept.textContent, 'Elimina');
    assert.equal(nodes.appConfirmDialog.classes.has('is-danger'), true);
    assert.equal(nodes.appConfirmDialog.open, true);
    assert.equal(context.document.activeElement, nodes.appConfirmCancel);
    assert.equal(context.document.body.classes.has('app-confirm-open'), true);
    const approve = nodes.appConfirmAccept.listeners.click;
    approve(); approve();
    assert.equal(await pending, true);
    assert.equal(nodes.appConfirmDialog.open, false);
    assert.equal(context.document.body.classes.has('app-confirm-open'), false);
    assert.equal(Object.keys(nodes.appConfirmDialog.listeners).length, 0);
    assert.equal(Object.keys(nodes.appConfirmAccept.listeners).length, 0);
    assert.equal(Object.keys(nodes.appConfirmCancel.listeners).length, 0);
    assert.equal(trigger.focusCalls, 1);
    assert.equal(context.document.activeElement, trigger);
});

test('Only one styled confirmation can be active and cancelling preserves the original prompt', async () => {
    const { context, nodes } = popupComponentsContext();
    const first = context.mostraConferma({ titolo: 'Prima conferma', messaggio: 'Prima richiesta' });
    assert.equal(await context.mostraConferma({ titolo: 'Seconda conferma', messaggio: 'Non deve sostituire la prima' }), false);
    assert.equal(nodes.appConfirmTitle.textContent, 'Prima conferma');
    assert.equal(nodes.appConfirmMessage.textContent, 'Prima richiesta');
    nodes.appConfirmCancel.listeners.click();
    assert.equal(await first, false);
    const next = context.mostraConferma({ titolo: 'Nuova conferma', messaggio: 'Ora disponibile' });
    nodes.appConfirmAccept.listeners.click();
    assert.equal(await next, true);
});

for (const dismissal of ['native-cancel', 'backdrop', 'external-close']) {
    test(`Styled confirmation resolves false on ${dismissal} and removes transient listeners`, async () => {
        const { context, nodes } = popupComponentsContext();
        const pending = context.mostraConferma({ titolo: 'Conferma', messaggio: 'Inviare?' });
        if (dismissal === 'native-cancel') {
            let prevented = false;
            nodes.appConfirmDialog.listeners.cancel({ preventDefault() { prevented = true; } });
            assert.equal(prevented, true);
        } else if (dismissal === 'backdrop') {
            nodes.appConfirmDialog.listeners.click({ target: nodes.appConfirmMessage });
            assert.equal(nodes.appConfirmDialog.open, true, 'Clicking dialog content must not dismiss it');
            nodes.appConfirmDialog.listeners.click({ target: nodes.appConfirmDialog });
        } else nodes.appConfirmDialog.close();
        assert.equal(await pending, false);
        assert.equal(nodes.appConfirmDialog.open, false);
        assert.equal(Object.keys(nodes.appConfirmDialog.listeners).length, 0);
    });
}

test('Confirmation fallback preserves the native safety prompt, and showModal failure cancels cleanly', async () => {
    const { context, nodes, trigger } = popupComponentsContext();
    const original = nodes.appConfirmDialog;
    delete nodes.appConfirmDialog;
    const calls = [];
    context.window.confirm = message => { calls.push(message); return true; };
    assert.equal(await context.mostraConferma({ titolo: 'Titolo', messaggio: 'Conferma nativa' }), true);
    assert.deepEqual(calls, ['Conferma nativa']);
    nodes.appConfirmDialog = original;
    original.showModal = () => { throw new Error('Dialogo non disponibile'); };
    trigger.isConnected = false;
    assert.equal(await context.mostraConferma({ titolo: 'Titolo', messaggio: 'Non aperto' }), false);
    assert.equal(Object.keys(original.listeners).length, 0);
    assert.equal(context.document.body.classes.has('app-confirm-open'), false);
    assert.equal(trigger.focusCalls, 0, 'Detached triggers must never receive restored focus');
});

test('Escape belongs to the top confirmation and does not close the appointment detail beneath it', async () => {
    const { context, nodes, windowListeners } = popupComponentsContext();
    nodes.modificaModal = context.document.createElement('div');
    nodes.modificaModal.style.display = 'block';
    let closed = 0;
    context.chiudiModificaModal = () => { closed++; };
    const pending = context.mostraConferma({ titolo: 'Conferma', messaggio: 'Eliminare?' });
    windowListeners.keydown.forEach(listener => listener({ key: 'Escape' }));
    assert.equal(closed, 0);
    nodes.appConfirmDialog.listeners.cancel({ preventDefault() {} });
    assert.equal(await pending, false);
    assert.equal(nodes.modificaModal.style.display, 'block');
    windowListeners.keydown.forEach(listener => listener({ key: 'Escape' }));
    assert.equal(closed, 1, 'A subsequent Escape can close the detail after confirmation dismissal');
});

test('Toasts render literal message/title text, use accessible status and error roles, and fall back safely for unknown types', () => {
    const { context, nodes } = popupComponentsContext();
    const message = '<img src=x onerror=alert(1)>';
    const title = '<b>Solo testo</b>';
    const toast = context.mostraToast(message, 'success', { titolo: title });
    const copy = toast.children[0].children[1];
    assert.equal(copy.children[0].textContent, title);
    assert.equal(copy.children[1].textContent, message);
    assert.equal(copy.children[0].innerHTML, '');
    assert.equal(copy.children[1].innerHTML, '');
    assert.equal(toast.getAttribute('role'), 'status');
    assert.equal(toast.getAttribute('aria-atomic'), 'true');
    assert.equal(toast.children[0].children[2].getAttribute('aria-label'), 'Chiudi notifica');
    assert.equal(nodes.appToastContainer.getAttribute('aria-label'), 'Notifiche del gestionale');
    const error = context.mostraToast('Errore', 'error');
    assert.equal(error.getAttribute('role'), 'alert');
    const fallback = context.mostraToast(null, '__proto__');
    assert.equal(fallback.className, 'app-toast app-toast-info');
    assert.equal(fallback.children[0].children[1].children[1].textContent, '');
});

for (const [type, duration] of [['success', 5000], ['info', 6000], ['warning', 9000], ['error', 10000]]) {
    test(`${type} notifications remain readable for ${duration}ms then disappear after their exit animation`, () => {
        const { context, tick } = popupComponentsContext();
        const toast = context.mostraToast('Messaggio di prova', type);
        assert.equal(toast.style['--toast-duration'], `${duration}ms`);
        tick(duration - 1);
        assert.equal(toast.isConnected, true);
        assert.equal(toast.classes.has('app-toast-hide'), false);
        tick(1);
        assert.equal(toast.classes.has('app-toast-hide'), true);
        tick(199);
        assert.equal(toast.isConnected, true);
        tick(1);
        assert.equal(toast.isConnected, false);
    });
}

test('Toast close is idempotent and retaining only the newest three clears discarded timers', () => {
    const { context, nodes, tick, timers } = popupComponentsContext();
    const toasts = Array.from({ length: 4 }, (_, index) => context.mostraToast(`Notifica ${index + 1}`));
    assert.equal(toasts[0].isConnected, false);
    assert.deepEqual(nodes.appToastContainer.children, toasts.slice(1));
    assert.equal(timers.size, 3);
    const close = toasts[3].children[0].children[2];
    close.listeners.click(); close.listeners.click();
    tick(200);
    assert.equal(toasts[3].isConnected, false);
    assert.equal(nodes.appToastContainer.children.length, 2);
    tick(10000);
    assert.equal(nodes.appToastContainer.children.length, 0);
    assert.equal(timers.size, 0);
});

test('Toast timeout pauses independently for pointer and keyboard focus, but a touch does not pin it open', () => {
    const { context, tick } = popupComponentsContext();
    const toast = context.mostraToast('Da leggere con calma');
    const close = toast.children[0].children[2];
    tick(1000);
    toast.listeners.pointerenter({ pointerType: 'mouse' });
    toast.listeners.focusin();
    tick(20000);
    assert.equal(toast.isConnected, true);
    assert.equal(toast.classes.has('is-paused'), true);
    toast.listeners.pointerleave();
    tick(20000);
    assert.equal(toast.classes.has('is-paused'), true, 'Keyboard focus must keep the timeout paused');
    toast.listeners.focusout({ relatedTarget: close });
    tick(20000);
    assert.equal(toast.isConnected, true, 'Moving focus within the toast must not resume its timeout');
    toast.listeners.focusout({ relatedTarget: null });
    assert.equal(toast.classes.has('is-paused'), false);
    tick(3999);
    assert.equal(toast.classes.has('app-toast-hide'), false);
    tick(201);
    assert.equal(toast.isConnected, false);
    const touchToast = context.mostraToast('Notifica touch');
    touchToast.listeners.pointerenter({ pointerType: 'touch' });
    assert.equal(touchToast.classes.has('is-paused'), false);
    tick(5200);
    assert.equal(touchToast.isConnected, false);
});
