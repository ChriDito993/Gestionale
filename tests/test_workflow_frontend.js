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
}

function mainContext() {
    const nodes = {};
    const document = {
        getElementById: id => nodes[id] || null, querySelectorAll: () => [], addEventListener() {},
        createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
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
