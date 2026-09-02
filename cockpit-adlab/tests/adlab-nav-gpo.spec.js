// E2E for the AD Lab plugin's URL routing + Group Policy stacking modals.
//   1. navigating tabs updates the URL (deep-linkable, Back/Forward work)
//   2. opening a modal updates the URL too
//   3. the Group Policy compose modal stacks a registry (ADMX-style) setting
//      and a preference onto a real GPO, and the settings actually land.
// A scratch GPO is created/removed by the run job and passed as ADLAB_TEST_GPO.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

const USER = 'cpadmin';
const PASS = fs.readFileSync(
    '/tmp/claude-1000/-home-eddie-Documents-ClaudeSystem/58fcb7e7-7b88-4060-9e49-748c304dc3bf/scratchpad/cpadmin.pass',
    'utf8').trim();
const FRAME = 'iframe[name="cockpit1:localhost/adlab"]';
const GPO = process.env.ADLAB_TEST_GPO || '';

async function elevate(page) {
    const limited = page.getByRole('button', { name: /limited access/i });
    if (!(await limited.isVisible().catch(() => false))) return;
    await limited.click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const pw = dlg.locator('input[type="password"]');
    if (await pw.isVisible().catch(() => false)) {
        await pw.fill(PASS);
        await dlg.getByRole('button', { name: /authenticate|log ?in/i }).first().click().catch(() => {});
    }
    const close = dlg.getByRole('button', { name: /^close$/i });
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    await page.getByText(/administrative access/i).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
}
async function login(page) {
    await page.goto('/adlab');
    await expect(page.locator('#login-user-input')).toBeVisible({ timeout: 15000 });
    await page.fill('#login-user-input', USER);
    await page.fill('#login-password-input', PASS);
    await page.click('#login-button');
    await page.waitForSelector(FRAME, { state: 'attached', timeout: 45000 });
    await elevate(page);
    await page.reload();
    await page.waitForSelector(FRAME, { state: 'attached', timeout: 45000 });
}
function adlabFrameObj(page) {
    return page.frames().find((f) => /\/adlab/.test(f.url()) || /adlab/.test(f.name()));
}
async function frame(page) {
    await page.waitForSelector(FRAME, { state: 'attached', timeout: 45000 });
    return page.frameLocator(FRAME);
}
async function frameHash(page) {
    const fr = adlabFrameObj(page);
    return fr ? fr.evaluate(() => window.location.hash) : '';
}

test('tab navigation is reflected in the URL and Back/Forward work', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    const f = await frame(page);
    await expect(f.locator('#al-identity')).toContainText('AD.EDT1.LAB', { timeout: 45000 });

    // click Group Policy -> URL carries /gpo
    await f.locator('#al-tabs button', { hasText: 'Group Policy' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('/gpo');
    await expect(f.locator('#al-tabs button.active')).toHaveText('Group Policy');

    // click DNS -> URL carries /dns
    await f.locator('#al-tabs button', { hasText: 'DNS' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('/dns');

    // Back returns to Group Policy (URL + active tab)
    await page.goBack();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('/gpo');
    await expect(f.locator('#al-tabs button.active')).toHaveText('Group Policy');

    // deep-link straight to a tab renders it
    const fr = adlabFrameObj(page);
    await fr.evaluate(() => { window.location.hash = '#/dcs'; });
    await expect(f.locator('#al-content')).toContainText('Domain controllers', { timeout: 20000 });
});

test('opening a modal updates the URL (deep-linkable), closing clears it', async ({ page }) => {
    test.setTimeout(120000);
    await login(page);
    const f = await frame(page);
    await expect(f.locator('#al-identity')).toContainText('AD.EDT1.LAB', { timeout: 45000 });
    await f.locator('#al-tabs button', { hasText: 'Group Policy' }).click();
    await expect(f.locator('#al-content')).toContainText('Group Policy objects', { timeout: 45000 });

    // ADMX central store button opens a routed modal
    await f.locator('.al-actions button', { hasText: 'ADMX central store' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('modal=gpo-admx');
    await expect(f.locator('.al-modal h2')).toContainText('ADMX central store', { timeout: 15000 });

    // closing (Back) clears the modal from the URL and removes it from the DOM
    await page.goBack();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).not.toContain('modal=');
    await expect(f.locator('.al-modal')).toHaveCount(0);
});

async function openCompose(f, page) {
    await f.locator('#al-tabs button', { hasText: 'Group Policy' }).click();
    await expect(f.locator('#al-content')).toContainText(GPO, { timeout: 45000 });
    await f.locator('table.al tr', { hasText: GPO }).locator('button', { hasText: 'compose' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('modal=gpo-compose');
    const modal = f.locator('.al-modal');
    await expect(modal).toContainText('Compose Group Policy', { timeout: 15000 });
    return modal;
}

test('compose modal: dropdowns are filterable picker tables, auto-loads current settings', async ({ page }) => {
    test.setTimeout(180000);
    expect(GPO, 'ADLAB_TEST_GPO must be set by the run job').toBeTruthy();
    await login(page);
    const f = await frame(page);
    await expect(f.locator('#al-identity')).toContainText('AD.EDT1.LAB', { timeout: 45000 });
    const modal = await openCompose(f, page);

    // AUTO-LOAD: the seeded setting is in the current-settings table on open
    await expect(modal).toContainText('Registry settings (auto-loaded', { timeout: 15000 });
    await expect(modal).toContainText('Seeded', { timeout: 30000 });   // seeded valuename

    // the source pickers are TABLES, not <select> dropdowns
    await expect(modal.locator('select')).toHaveCount(0);
    await expect(modal).toContainText('Add settings from a template GPO');
    await expect(modal).toContainText('Add from an ADMX policy');
    await expect(modal).toContainText('Add a raw registry setting');
    await expect(modal).toContainText('Add a preference (samba CSE)');

    // ADMX picker: load, then the filter narrows the table and unresolved names
    // are hidden by default (a toggle is offered)
    await modal.getByRole('button', { name: 'Load ADMX to central store' }).click();
    const admxCard = modal.locator('.al-card', { hasText: 'Add from an ADMX policy' });
    await expect(admxCard).toContainText('show unresolved policy names', { timeout: 30000 });
    // the policy picker is the FIRST picker in the card (the state picker is second)
    const polPicker = admxCard.locator('.al-picker').first();
    await expect(polPicker.locator('.al-picker-table tr')).not.toHaveCount(0, { timeout: 15000 });
    const before = await polPicker.locator('.al-picker-table tr').count();
    await polPicker.locator('.al-picker-filter').fill('Disable Printing');
    await expect.poll(async () => polPicker.locator('.al-picker-table tr').count(),
        { timeout: 10000 }).toBeLessThan(before);
});

test('compose modal: value editor has Hex/Text modes for binary; edit + preference apply', async ({ page }) => {
    test.setTimeout(180000);
    expect(GPO).toBeTruthy();
    await login(page);
    const f = await frame(page);
    await expect(f.locator('#al-identity')).toContainText('AD.EDT1.LAB', { timeout: 45000 });
    const modal = await openCompose(f, page);
    await expect(modal).toContainText('Seeded', { timeout: 30000 });

    // ③ add a raw registry setting via the value editor, type REG_BINARY -> Hex/Text
    const raw = modal.locator('.al-card', { hasText: 'Add a raw registry setting' });
    await raw.locator('input[placeholder^="Software"]').fill('Software\\Policies\\Adlab\\E2E');
    await raw.locator('input[placeholder="valueName"]').fill('Blob');
    // value editor: pick REG_BINARY in its type picker table
    await raw.locator('.al-veditor .al-picker-table tr', { hasText: 'REG_BINARY' }).click();
    await expect(raw.locator('.al-vmode')).toContainText('Hex');
    await expect(raw.locator('.al-vmode')).toContainText('Text');
    await raw.locator('.al-vdata textarea').fill('de ad be ef');
    await raw.getByRole('button', { name: 'Add setting' }).click();
    // the working table now shows the new row (hex preview)
    await expect(modal.locator('.al-card', { hasText: 'Registry settings' })).toContainText('Blob', { timeout: 15000 });

    // ④ stage a motd preference via the CSE picker table (single-select)
    const pref = modal.locator('.al-card', { hasText: 'Add a preference (samba CSE)' });
    await pref.locator('.al-picker-table tr', { hasText: 'motd' }).click();
    await pref.locator('input[placeholder^="value"]').fill('AD Lab e2e MOTD');
    await pref.getByRole('button', { name: 'Stage preference' }).click();
    await expect(modal.locator('.al-card', { hasText: 'Staged preferences' })).toContainText('motd');

    // apply — surgical: adds/edits merge, preferences set
    await modal.getByRole('button', { name: 'Apply to GPO' }).click();
    await expect(modal).toContainText('Applied to GPO', { timeout: 60000 });
    await expect(modal).toContainText('"applied"');
    await modal.getByRole('button', { name: 'Close' }).click();

    // the settings modal shows the binary value we added
    await f.locator('table.al tr', { hasText: GPO }).locator('button', { hasText: 'settings' }).click();
    await expect(f.locator('.al-modal')).toContainText('Blob', { timeout: 30000 });
    await expect(f.locator('.al-modal')).toContainText('REG_BINARY');
});
