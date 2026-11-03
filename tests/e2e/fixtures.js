const { test: base, expect } = require('@playwright/test');
const path = require('node:path');
const BASE = 'http://127.0.0.1:39781';
const CONTROL = { 'X-E2E-Control': 'isolated-browser-suite' };
const bundle = path.resolve(__dirname, '../../node_modules/fullcalendar/index.global.min.js');
const reads = new WeakMap();

async function settleReads(page) {
    const state = reads.get(page);
    if (!state) return;
    // Only before test-driven full navigation: let outstanding reads finish so
    // WebKit does not report cancelled intercepted fetches as CORS exceptions.
    await expect.poll(() => state.pending.size === 0 && Date.now() - state.changed > 100).toBe(true);
}

const test = base.extend({
    scenario: [async ({ context, request, page }, use, testInfo) => {
        const reset = await request.post('/__e2e__/reset', { headers: CONTROL });
        expect(reset.ok()).toBeTruthy();
        const { date } = await reset.json();
        const pageErrors = [];
        const externalRequests = [];
        const serverErrors = [];
        const scenario = { date, allowCalendarFailure: false };
        const watch = tab => {
            const pending = { pending: new Set(), changed: 0 };
            reads.set(tab, pending);
            tab.on('request', req => {
                const url = new URL(req.url());
                if (req.method() === 'GET' && url.origin === BASE && url.pathname.startsWith('/api/')) {
                    pending.pending.add(req);
                    pending.changed = Date.now();
                }
            });
            const finished = req => {
                if (pending.pending.delete(req)) pending.changed = Date.now();
            };
            tab.on('requestfinished', finished);
            tab.on('requestfailed', finished);
            tab.on('pageerror', error => pageErrors.push(error.message));
            tab.on('response', response => {
                if (response.status() < 500) return;
                const pathname = new URL(response.url()).pathname;
                if (scenario.allowCalendarFailure && response.status() === 503 && pathname === '/api/appuntamenti') return;
                serverErrors.push(`${response.status()} ${pathname}`);
            });
        };
        context.on('page', watch);
        watch(page);
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.origin === BASE) return route.continue();
            if (url.href === 'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.15/index.global.min.js') {
                return route.fulfill({ path: bundle, contentType: 'application/javascript' });
            }
            externalRequests.push(url.origin + url.pathname);
            return route.abort('blockedbyclient');
        });
        const state = async () => {
            const response = await request.get('/__e2e__/state', { headers: CONTROL });
            expect(response.ok()).toBeTruthy();
            return response.json();
        };
        scenario.state = state;
        await use(scenario);
        if (testInfo.status === testInfo.expectedStatus) {
            expect(pageErrors, 'Unexpected JavaScript errors').toEqual([]);
            expect(externalRequests, 'Unexpected external browser requests').toEqual([]);
            expect(serverErrors, 'Unexpected server errors').toEqual([]);
            expect((await state()).email_attempts, 'No test may attempt email delivery').toBe(0);
        }
    }, { auto: true }],
});

async function login(page) {
    await page.goto('/login');
    await page.getByLabel('Indirizzo email').fill('browser@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
    await page.getByRole('button', { name: 'Accedi al gestionale' }).click();
    await expect(page).toHaveURL(BASE + '/');
    await expect(page.locator('#calendarNew')).toBeEnabled();
    await settleReads(page);
}

async function chooseDate(page, date) {
    await page.locator('#calendarDate').fill(date);
    await page.locator('#calendarDate').press('Tab');
    await expect(page.locator('#calendarNew')).toBeEnabled();
}

async function appointmentForm(page, date, { couple = false, start = '10:00', end = '11:00' } = {}) {
    await page.locator('#calendarNew').click();
    const modal = page.locator('#eventoModal');
    await expect(modal).toBeVisible();
    await modal.getByLabel('Chi partecipa').fill('Mario');
    await page.locator('#risultatiClienti').getByText('Mario Bianchi', { exact: true }).click();
    if (couple) {
        await modal.getByLabel('Chi partecipa').fill('Élodie');
        await page.locator('#risultatiClienti').getByText('Élodie Rossi', { exact: true }).click();
    }
    await modal.locator('#servizioSelect').selectOption('10');
    await modal.locator('#eventoData').fill(date);
    await modal.locator('#eventoOraInizio').fill(start);
    await modal.locator('#eventoOraFine').fill(end);
    await modal.locator('#eventoInviaConfermaEmail').uncheck();
    await modal.locator('summary').click();
    await modal.locator('#eventoNote').fill('Nota sintetica del test browser');
    return modal;
}

async function saveAppointment(page, date, options) {
    const modal = await appointmentForm(page, date, options);
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/appuntamenti' && response.request().method() === 'POST');
    await modal.getByRole('button', { name: /^Salva appuntamento$/i }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
    expect(response.request().headers()['x-csrf-token']).toBeTruthy();
    await expect(modal).toBeHidden();
}

module.exports = { test, expect, login, chooseDate, appointmentForm, saveAppointment, settleReads, BASE };
