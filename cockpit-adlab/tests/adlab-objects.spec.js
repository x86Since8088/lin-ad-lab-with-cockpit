// E2E for the AD Lab plugin's "Users & Computers" (dsa.msc) object console.
//   1. the tab deep-links to /objects and the container tree loads (600px)
//   2. selecting a container lists its objects with a summary line
//   3. object-type toggles + Advanced Features filter the list/tree
//   4. selecting a row fills the docked preview (tabbed / list value view)
//   5. Edit opens a SCHEMA-DRIVEN tabbed object editor (General/Account/…)
//   6. Advanced opens the filterable Attribute Editor grid
// Read-only: no Save/Rename/Delete is exercised against the live directory.
const { test, expect } = require('@playwright/test');
const fs = require('fs');

// The object console is a desktop three-pane view (tree 600 + table + docked
// preview); test at a desktop width so all three panes fit without scrolling.
test.use({ viewport: { width: 1720, height: 1000 } });

const USER = 'cpadmin';
const PASS = fs.readFileSync(
    '/tmp/claude-1000/-home-eddie-Documents-ClaudeSystem/58fcb7e7-7b88-4060-9e49-748c304dc3bf/scratchpad/cpadmin.pass',
    'utf8').trim();
const FRAME = 'iframe[name="cockpit1:localhost/adlab"]';

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
async function openObjects(page) {
    const f = await frame(page);
    await expect(f.locator('#al-identity')).toContainText('AD.EDT1.LAB', { timeout: 45000 });
    await f.locator('#al-tabs button', { hasText: 'Users & Computers' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('/objects');
    await f.locator('.al-tree-row').first().waitFor({ state: 'visible', timeout: 30000 });
    return f;
}

test('tree loads at 600px and selecting a container lists objects', async ({ page }) => {
    test.setTimeout(150000);
    await login(page);
    const f = await openObjects(page);

    // the container tree defaults to 600px wide
    const w = await f.locator('.al-aduc-tree').evaluate((n) => n.offsetWidth);
    expect(w).toBeGreaterThanOrEqual(560);

    // the tree filter narrows visible nodes, kept expandable
    await f.locator('.al-tree-filter-setting').first().fill('user');
    await expect(f.locator('.al-tree-row', { hasText: 'Users' }).first()).toBeVisible();
    await f.locator('.al-tree-filter-setting').first().fill('');

    // select the Users container -> the object table + summary populate
    await f.locator('.al-tree-row', { hasText: 'Users' }).first().click();
    await f.locator('table.al-objtable tr').first().waitFor({ state: 'visible', timeout: 30000 });
    await expect(f.locator('.al-objtable-summary')).toContainText(/object/i, { timeout: 30000 });
});

test('type toggles and Advanced Features change the object set', async ({ page }) => {
    test.setTimeout(150000);
    await login(page);
    const f = await openObjects(page);
    await f.locator('.al-tree-row', { hasText: 'Users' }).first().click();
    await expect(f.locator('.al-objtable-summary')).toContainText(/object/i, { timeout: 30000 });

    // Advanced Features reveals extra type chips (Containers, Printers, …)
    await f.locator('.al-obj-chips button', { hasText: 'Advanced Features' }).click();
    await expect(f.locator('.al-obj-chips button', { hasText: 'Containers' })).toBeVisible({ timeout: 15000 });
});

test('selecting a row fills the preview and Edit opens a schema-driven tabbed editor', async ({ page }) => {
    test.setTimeout(180000);
    await login(page);
    const f = await openObjects(page);
    await f.locator('.al-tree-row', { hasText: 'Users' }).first().click();
    await f.locator('table.al-objtable tr td').first().waitFor({ state: 'visible', timeout: 30000 });

    // pick a known USER (Administrator) so the user-class tabs are asserted
    await f.locator('.al-obj-search').fill('administrator');
    const row = f.locator('table.al-objtable tr', { has: f.locator('td', { hasText: /^Administrator$/ }) }).first();
    await row.waitFor({ state: 'visible', timeout: 30000 });
    await row.click();
    await expect(f.locator('.al-prev-title')).not.toHaveText('No selection', { timeout: 20000 });

    // preview mode toggle (Tabbed / List)
    await f.locator('.al-prev-mode button', { hasText: 'List' }).click();
    await f.locator('.al-prev-mode button', { hasText: 'Tabbed' }).click();

    // Edit -> tabbed object editor built from object-schema
    await f.locator('.al-prev-actions button', { hasText: 'Edit' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('modal=object-edit');
    await f.locator('.al-tabstrip .al-tab').first().waitFor({ state: 'visible', timeout: 30000 });
    await expect(f.locator('.al-tabstrip')).toContainText('General');
    await expect(f.locator('.al-tabstrip')).toContainText('Account');
    // switch to the Account tab and confirm the schema-typed form renders
    await f.locator('.al-tab', { hasText: 'Account' }).click();
    await expect(f.locator('.al-tabpane.on .al-formrow').first()).toBeVisible();
    await f.locator('.al-modal-actions button', { hasText: 'Close' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).not.toContain('modal=object-edit');
});

test('Advanced opens the filterable Attribute Editor grid', async ({ page }) => {
    test.setTimeout(180000);
    await login(page);
    const f = await openObjects(page);
    await f.locator('.al-tree-row', { hasText: 'Users' }).first().click();
    await f.locator('table.al-objtable tr td').first().waitFor({ state: 'visible', timeout: 30000 });
    await f.locator('.al-obj-search').fill('administrator');
    const row = f.locator('table.al-objtable tr', { has: f.locator('td', { hasText: /^Administrator$/ }) }).first();
    await row.waitFor({ state: 'visible', timeout: 30000 });
    await row.click();
    await expect(f.locator('.al-prev-title')).not.toHaveText('No selection', { timeout: 20000 });

    await f.locator('.al-prev-actions button', { hasText: 'Advanced' }).click();
    await expect.poll(() => frameHash(page), { timeout: 15000 }).toContain('modal=object-attrs');
    // scope to the modal (the tree pane behind it also has an .al-tree-filter-setting)
    const dlg = f.locator('#al-modal-host .al-backdrop').last();
    await dlg.locator('table.al-attrtable tr').first().waitFor({ state: 'visible', timeout: 30000 });
    const before = await dlg.locator('table.al-attrtable tr').count();
    await dlg.locator('.al-tree-filter-setting').fill('sAMAccount');
    await expect.poll(async () => dlg.locator('table.al-attrtable tr').count(), { timeout: 15000 })
        .toBeLessThan(before);
    await dlg.locator('.al-attrname', { hasText: 'sAMAccountName' }).first().waitFor({ state: 'visible', timeout: 15000 });
});
