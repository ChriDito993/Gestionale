const { test, expect, login, chooseDate, appointmentForm, saveAppointment, settleReads, BASE } = require('./fixtures');

// Real browser + real Flask routes/session/CSRF. Only database and transports are doubles.
test('accesso errato, accesso valido, cookie protetti e logout dal pulsante', async ({ page, context }) => {
    await page.goto('/');
    await expect(page).toHaveURL(BASE + '/login');
    await page.getByLabel('Indirizzo email').fill('browser@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: 'Accedi al gestionale' }).click();
    await expect(page.getByRole('alert')).toContainText('Credenziali non valide');
    await page.getByLabel('Indirizzo email').fill('browser@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('browser-test-password');
    await page.getByRole('button', { name: 'Accedi al gestionale' }).click();
    await expect(page.locator('#calendarNew')).toBeEnabled();
    const cookie = (await context.cookies()).find(cookie => cookie.name === 'session');
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    await settleReads(page);
    await page.getByRole('button', { name: 'Esci dal gestionale' }).click();
    await expect(page).toHaveURL(BASE + '/login');
    await page.goto('/clienti');
    await expect(page).toHaveURL(BASE + '/login');
});

test('creazione cliente, ricerca con accenti, vista lista e modifica anagrafica persistente', async ({ page, scenario }) => {
    await login(page);
    await page.getByRole('button', { name: 'Nuovo cliente', exact: true }).click();
    const modal = page.locator('#clienteModal');
    await modal.getByPlaceholder('Nome', { exact: true }).fill('Émile');
    await modal.getByPlaceholder('Cognome', { exact: true }).fill('Test Browser');
    await modal.getByPlaceholder('Telefono', { exact: true }).fill('3330000002');
    await modal.getByPlaceholder('Email', { exact: true }).fill('emile@example.invalid');
    await modal.getByRole('button', { name: 'Salva Cliente', exact: true }).click();
    await expect(modal).toBeHidden();
    await settleReads(page);
    await page.getByRole('link', { name: 'Archivio clienti' }).click();
    await page.getByRole('searchbox').fill('emile test browser');
    await expect(page.locator('#clientiVisibili')).toHaveText('1 cliente');
    await page.getByRole('button', { name: 'Lista', exact: true }).click();
    await expect(page.locator('#clientiContainer')).toHaveClass(/list-view/);
    await page.locator('.cliente-item:visible').click();
    await page.locator('.btn-anagrafica-open').click();
    await page.locator('#modNome').fill('Émile aggiornato');
    await page.locator('#modDataNascita').fill('1991-05-12');
    await page.locator('#profileEditSave').click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Émile aggiornato');
    await page.getByLabel('Note cliniche del cliente').fill('Nota di prova senza dati reali');
    await page.getByRole('button', { name: 'Salva note', exact: true }).click();
    await expect(page.getByLabel('Note cliniche del cliente')).toHaveValue('Nota di prova senza dati reali');
    const customer = (await scenario.state()).clienti.find(row => row.email === 'emile@example.invalid');
    expect(customer.nome).toBe('Émile aggiornato');
    expect(customer.data_nascita).toBe('1991-05-12');
    expect(customer.telefono).toBe('393330000002');
});

test('appuntamento di coppia: salvataggio, ricarica, modifica e cancellazione confermata', async ({ page, scenario }) => {
    await login(page);
    await chooseDate(page, scenario.date);
    await saveAppointment(page, scenario.date, { couple: true });
    let state = await scenario.state();
    expect(state.appuntamenti).toHaveLength(1);
    expect(state.partecipanti).toHaveLength(2);
    expect(state.pacchetti[0].sedute_effettuate).toBe(1);
    await settleReads(page);
    await page.reload();
    await chooseDate(page, scenario.date);
    const event = page.locator('#calendar .fc-event').filter({ hasText: 'Mario Bianchi' });
    await expect(event).toHaveCount(1);
    await expect(event).toContainText('Élodie Rossi');
    await event.click();
    const details = page.locator('#modificaModal');
    await expect(details).toBeVisible();
    await details.getByLabel('Note appuntamento').fill('Nota modificata nel browser');
    await details.locator('#oraFineModifica').fill('11:30');
    await details.getByRole('button', { name: 'Salva modifiche', exact: true }).click();
    await expect(details).toBeHidden();
    await expect.poll(async () => (await scenario.state()).appuntamenti[0].note).toBe('Nota modificata nel browser');
    await event.click();
    await details.getByRole('button', { name: 'Elimina appuntamento', exact: true }).click();
    await page.locator('#appConfirmCancel').click();
    expect((await scenario.state()).appuntamenti).toHaveLength(1);
    await details.getByRole('button', { name: 'Elimina appuntamento', exact: true }).click();
    await page.locator('#appConfirmAccept').click();
    await expect(details).toBeHidden();
    await expect(event).toHaveCount(0);
    state = await scenario.state();
    expect(state.appuntamenti).toHaveLength(0);
    expect(state.pacchetti[0].sedute_effettuate).toBe(0);
});

test('annullare l’avviso di sovrapposizione non crea appuntamenti', async ({ page, scenario }) => {
    await login(page);
    await chooseDate(page, scenario.date);
    await saveAppointment(page, scenario.date);
    const modal = await appointmentForm(page, scenario.date, { start: '10:30', end: '11:30' });
    const prompt = page.waitForEvent('dialog');
    page.once('dialog', dialog => dialog.dismiss());
    await modal.getByRole('button', { name: /^Salva appuntamento$/i }).click();
    const warning = await prompt;
    expect(warning.type()).toBe('confirm');
    expect(warning.message()).toContain('sovrappongono');
    await expect(modal).toBeVisible();
    expect((await scenario.state()).appuntamenti).toHaveLength(1);
});

test('richieste senza token CSRF e GET di invio email sono respinte', async ({ page, scenario }) => {
    await login(page);
    const before = await scenario.state();
    const rejected = await page.request.post('/api/clienti', { data: { nome: 'Non salvare', cognome: 'CSRF' } });
    expect(rejected.status()).toBe(400);
    expect((await rejected.json()).error).toContain('Ricarica');
    expect((await scenario.state()).clienti).toHaveLength(before.clienti.length);
    expect((await page.request.get('/invia_promemoria/123')).status()).toBe(405);
    expect((await page.request.get('/logout')).status()).toBe(405);
    await settleReads(page);
    await page.goto('/clienti');
    await expect(page.getByRole('heading', { name: 'Archivio clienti' })).toBeVisible();
});

test('agenda: viste giorno/settimana e navigazione orizzontale del trackpad', async ({ page, isMobile }) => {
    await login(page);
    await page.locator('#calendarViewWeek').click();
    await expect(page.locator('#calendarViewWeek')).toHaveAttribute('aria-pressed', 'true');
    if (isMobile) {
        await expect(page.locator('#calendar')).toHaveClass(/is-mobile-week/);
        await page.locator('#calendarViewDay').click();
        await expect(page.locator('#calendar')).toHaveClass(/is-mobile-day/);
        return;
    }
    const input = page.locator('#calendarDate');
    const previous = await input.inputValue();
    const next = new Date(previous + 'T12:00:00Z');
    // FullCalendar's next week starts on Monday, regardless of the current anchor day.
    next.setUTCDate(next.getUTCDate() - ((next.getUTCDay() + 6) % 7) + 7);
    await page.locator('#calendar').hover();
    await page.mouse.wheel(100, 0);
    await expect(input).toHaveValue(next.toISOString().slice(0, 10));
    await page.mouse.wheel(0, 150);
    await expect(input).toHaveValue(next.toISOString().slice(0, 10));
    await page.locator('#calendarViewDay').click();
    await expect(page.locator('#calendarViewDay')).toHaveAttribute('aria-pressed', 'true');
});

test('agenda non disponibile: errore esplicito, creazione bloccata e recupero con Riprova', async ({ page, scenario }) => {
    await login(page);
    const pattern = '**/api/appuntamenti?**';
    scenario.allowCalendarFailure = true;
    await page.route(pattern, route => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Errore simulato nel test' }),
    }));
    await settleReads(page);
    await page.reload();
    await expect(page.locator('#calendarRetry')).toBeVisible();
    await expect(page.locator('#calendarNew')).toBeDisabled();
    await expect(page.locator('#calendarStatusText')).toContainText('Agenda non aggiornata');
    await page.unroute(pattern);
    await page.locator('#calendarRetry').click();
    await expect(page.locator('#calendarNew')).toBeEnabled();
    await expect(page.locator('#calendarRetry')).toBeHidden();
});
