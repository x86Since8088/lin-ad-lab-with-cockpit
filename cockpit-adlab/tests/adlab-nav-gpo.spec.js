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

test('Group Policy compose modal stacks a registry setting and a preference', async ({ page }) => {
    test.setTimeout(180000);
    expect(GPO, 'ADLAB_TEST_GPO must be set by the run job').toBeTruthy();
    await login(page);
    const f = await frame(page);
    await expect(f.locator('#al-identity')).toContainText('AD.EDT1.LAB', { timeout: 45000 });
    await f.locator('#al-tabs button', { hasText: 'Group Policy' }).click();
    await expect(f.locator('#al-content')).toContainText(GPO, { timeout: 45000 });

    // open compose on the scratch GPO's row
    await f.locator('table.al tr', { hasText: GPO }).locator('button', { hasText: 'compose' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('modal=gpo-compose');
    const modal = f.locator('.al-modal');
    await expect(modal).toContainText('Compose Group Policy', { timeout: 15000 });
    // the four stacking sources are present
    await expect(modal).toContainText('Stack from a template GPO');
    await expect(modal).toContainText('Stack an ADMX policy');
    await expect(modal).toContainText('raw registry setting');
    await expect(modal).toContainText('preference (samba CSE)');

    // ③ add a raw registry (Administrative-Template) layer
    await modal.locator('input[placeholder^="Software"]').fill('Software\\Policies\\Adlab\\E2E');
    await modal.locator('input[placeholder="valueName"]').fill('Marker');
    await modal.locator('input[placeholder="data"]').fill('1');
    // pick REG_DWORD in the ③ panel (the panel whose header mentions "raw registry")
    const regPanel = modal.locator('.al-card', { hasText: 'raw registry setting' });
    await regPanel.locator('select').nth(1).selectOption('REG_DWORD');   // type select
    await regPanel.getByRole('button', { name: 'Add registry layer' }).click();
    await expect(modal.locator('.al-stack-row')).toHaveCount(1);

    // ④ add a preference layer (motd)
    const prefPanel = modal.locator('.al-card', { hasText: 'preference (samba CSE)' });
    await prefPanel.locator('select').selectOption('motd');
    await prefPanel.locator('input[placeholder="value"]').fill('AD Lab e2e MOTD');
    await prefPanel.getByRole('button', { name: 'Add preference layer' }).click();
    await expect(modal.locator('.al-stack-row')).toHaveCount(2);

    // apply the stack
    await modal.getByRole('button', { name: 'Apply stack to GPO' }).click();
    await expect(modal).toContainText('Applied to GPO', { timeout: 60000 });
    await expect(modal).toContainText('"applied"');
    await modal.getByRole('button', { name: 'Close' }).click();

    // the settings tab (gpo-detail) now shows the registry setting we stacked
    await f.locator('table.al tr', { hasText: GPO }).locator('button', { hasText: 'settings' }).click();
    await expect(f.locator('.al-modal')).toContainText('Marker', { timeout: 30000 });
    await expect(f.locator('.al-modal')).toContainText('Software\\Policies\\Adlab\\E2E');
});
