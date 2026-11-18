/**
 * Phase 2 in a real browser.
 *
 * The things only a browser catches: whether the JavaScript actually runs
 * under the content security policy, whether the duplicate warning appears
 * as you type, whether the quote arrives when a plan is picked, and whether
 * a check-in puts the member's name on screen.
 *
 * A CSP that blocks every script passes every unit test ever written. That
 * bug has already happened once on this project, which is why this file
 * exists and why it fails loudly on a single console error.
 */

import { createRequire } from 'node:module';

/**
 * Playwright may be a project dependency or installed globally on the build
 * machine. ESM ignores NODE_PATH, so it is resolved through CommonJS, which
 * does not — the test runs either way rather than only where it was written.
 */
const require = createRequire(import.meta.url);
const resolvePlaywright = () => {
  for (const candidate of [
    'playwright',
    '/opt/npm-tools/node_modules/playwright',
    'playwright-core',
  ]) {
    try {
      return require(candidate);
    } catch {
      // Try the next.
    }
  }
  throw new Error('Playwright is not installed. `pnpm add -D playwright` or install it globally.');
};

const { chromium } = resolvePlaywright();

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3100';
const stamp = Date.now();

const gym = {
  name: `Browser Gym ${stamp}`,
  owner: 'Browser Owner',
  email: `browser.${stamp}@example.com`,
  phone: `98${String(stamp).slice(-8)}`,
  password: 'correct horse battery staple 47',
};

const member = {
  firstName: 'Ravi',
  lastName: 'Kulkarni',
  phone: `97${String(stamp).slice(-8)}`,
};

let passed = 0;
let failed = 0;
const consoleErrors = [];
const badResponses = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // "Failed to load resource" duplicates what the response listener records,
  // with none of the detail — the status and URL are tracked below instead.
  if (text.startsWith('Failed to load resource')) return;
  consoleErrors.push(text);
});

page.on('response', (response) => {
  const status = response.status();
  if (status < 400) return;

  const url = response.url();
  // A 401 on an API probe is a deliberate part of the flow; an icon that is
  // not there is cosmetic. Everything else is a real broken request.
  if (/favicon|\.ico$|icon\.svg/.test(url)) return;
  badResponses.push(`${status} ${response.request().method()} ${url.replace(BASE, '')}`);
});

// A prefetch cancelled by the navigation that followed it is normal and is
// deliberately not recorded: Playwright reports those as request failures.

try {
  // ---------------------------------------------------------------- setup ---
  section('Registering a gym');
  await page.goto(`${BASE}/register-gym`, { waitUntil: 'domcontentloaded' });

  await page.fill('#gymName', gym.name);
  await page.fill('#ownerName', gym.owner);
  await page.fill('#email', gym.email);
  await page.fill('#phone', gym.phone);
  await page.fill('#password', gym.password);

  const terms = page.locator('input[type="checkbox"]').first();
  if (await terms.count()) await terms.check();

  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  check('registration lands on the dashboard', page.url().includes('/dashboard'));

  // The password must never reach the URL. This is what the CSP bug caused:
  // JavaScript blocked, the form degraded to a native GET, credentials in
  // the address bar and in every log between here and the server.
  check('no credentials in the URL', !page.url().includes('password'), page.url());

  // ------------------------------------------------------------ dashboard ---
  section('Dashboard');
  const emptyState = await page.getByText('No members yet').count();
  check('an empty gym says so rather than inventing numbers', emptyState > 0);

  // ----------------------------------------------------------------- plan ---
  section('Creating a plan');
  await page.goto(`${BASE}/memberships/plans`, { waitUntil: 'domcontentloaded' });
  check('plans page renders', (await page.getByRole('heading', { name: 'Plans' }).count()) > 0);

  await page.getByRole('button', { name: 'New plan' }).click();
  await page.fill('#plan-name', 'Monthly');
  await page.fill('#plan-price', '1500');
  await page.fill('#plan-graceDays', '3');
  // Freezing is off by default on a new plan, and the subscriptions screen
  // only offers Freeze where the plan permits it — so turn it on here, which
  // is also what a real gym offering a freeze would do.
  await page.getByLabel('Members may freeze this membership').check();
  await page.fill('#plan-freezeMaxDays', '15');
  await page.getByRole('button', { name: 'Create plan' }).click();

  await page.waitForFunction(
    () => document.body.innerText.includes('Monthly'),
    undefined,
    { timeout: 20_000 },
  );
  check('the plan appears in the list', (await page.getByText('Monthly').count()) > 0);
  check('its price is formatted in rupees', (await page.getByText('₹1,500.00').count()) > 0);
  check('its grace period is shown', (await page.getByText('3-day grace').count()) > 0);

  // --------------------------------------------------------------- member ---
  section('Registering a member');
  await page.goto(`${BASE}/members/new`, { waitUntil: 'domcontentloaded' });

  await page.fill('#field-firstName', member.firstName);
  await page.fill('#field-lastName', member.lastName);
  await page.fill('#field-phone', member.phone);

  // The optional details are inside a <details>, which must be opened before
  // its fields can be filled. These are the fields that were silently thrown
  // away when the contract nested them.
  await page.locator('details summary').click();
  await page.fill('#field-addressLine1', '12 MG Road');
  await page.fill('#field-city', 'Pune');
  await page.fill('#field-emergencyContactName', 'Sunita Kulkarni');
  await page.fill('#field-emergencyContactPhone', '9823012345');

  await page.click('button[type="submit"]');

  await page.waitForURL(/\/members\/[0-9a-f-]{36}/, { timeout: 20_000 });
  // Strip the ?welcome=1 the redirect adds, so sub-paths build correctly.
  const memberUrl = page.url().split('?')[0];
  check('registration lands on the profile', /\/members\/[0-9a-f-]{36}/.test(memberUrl));
  check(
    'the member code is shown',
    (await page.getByText(/M\d{5}/).count()) > 0,
  );
  check(
    'the address typed at the desk was actually saved',
    (await page.getByText(/12 MG Road/).count()) > 0,
  );
  check(
    'and so was the emergency contact',
    (await page.getByText(/Sunita Kulkarni/).count()) > 0,
  );

  // --- the duplicate warning, as it is typed
  section('The duplicate check');
  await page.goto(`${BASE}/members/new`, { waitUntil: 'domcontentloaded' });
  await page.fill('#field-firstName', 'Priya');
  await page.fill('#field-phone', member.phone);

  // Typed, debounced, fetched, rendered — all of it client-side JavaScript.
  await page.waitForFunction(
    () => document.body.innerText.includes('already on file'),
    undefined,
    { timeout: 10_000 },
  );
  check('a repeated number warns before submitting', true);
  check(
    'it names who it collided with',
    (await page.getByText(`${member.firstName} ${member.lastName}`).count()) > 0,
  );

  const submitDisabled = await page
    .locator('button[type="submit"]')
    .first()
    .isDisabled();
  check('the form is still submittable, since families share numbers', !submitDisabled);

  // ------------------------------------------------------------ the sale ---
  section('Selling a membership');
  await page.goto(memberUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Sell membership' }).click();

  await page.selectOption('#plan', { index: 1 });

  // The quote comes from the server, computed by the same function the sale
  // uses. If this never appears, the counter is guessing at the price.
  await page.waitForFunction(
    () => document.body.innerText.includes('Before tax'),
    undefined,
    { timeout: 15_000 },
  );
  check('the server quotes the price', true);
  check('the total is the plan price', (await page.getByText('₹1,500.00').count()) > 0);
  check('tax is backed out of it', (await page.getByText('₹228.81').count()) > 0);
  check('the taxable part is shown', (await page.getByText('₹1,271.19').count()) > 0);
  check(
    'it says the last day is included',
    (await page.getByText(/last day is included/i).count()) > 0,
  );

  await page.getByRole('button', { name: /Take ₹/ }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Monthly') && !document.body.innerText.includes('Before tax'),
    undefined,
    { timeout: 20_000 },
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  check('the membership is on the profile', (await page.getByText('Monthly').count()) > 0);
  check(
    'it reads as active with days left',
    (await page.getByText(/\d+d left/).count()) > 0,
  );

  // --------------------------------------------------------- the check-in ---
  section('Checking a member in');
  await page.goto(`${BASE}/attendance/today`, { waitUntil: 'domcontentloaded' });
  check('the check-in box is focused and ready', (await page.locator('#scan').count()) > 0);

  const codeText = await page.evaluate(async () => {
    const response = await fetch('/api/v1/members?pageSize=1');
    const payload = await response.json();
    return payload.data?.[0]?.memberCode ?? null;
  });
  check('the members API answers the browser', Boolean(codeText), String(codeText));

  await page.fill('#scan', codeText);
  await page.press('#scan', 'Enter');

  await page.waitForFunction(
    () => document.body.innerText.includes('Welcome'),
    undefined,
    { timeout: 15_000 },
  );
  check('the member is let in', true);
  check(
    'their name is on screen, not just a code',
    (await page.getByText(`${member.firstName} ${member.lastName}`).count()) > 0,
  );
  check('the visit is listed', (await page.getByText('Still in').count()) > 0);

  // --- a second scan the same day
  await page.fill('#scan', codeText);
  await page.press('#scan', 'Enter');
  await page.waitForFunction(
    () => document.body.innerText.includes('already checked in'),
    undefined,
    { timeout: 15_000 },
  );
  check('a second scan is refused, with the name still shown', true);
  check('it is not shown as an error', (await page.getByText('Not in').count()) > 0);

  // ------------------------------------------------------------- the money ---
  section('Payments');
  await page.goto(`${BASE}/finance/payments`, { waitUntil: 'domcontentloaded' });
  check('the payment is in the ledger', (await page.getByText('₹1,500.00').count()) > 0);
  check(
    'a receipt number was issued',
    (await page.getByText(/RCP\/\d{4}-\d{2}\/\d{5}/).count()) > 0,
  );
  check('today\'s collection is totalled', (await page.getByText('Collected today').count()) > 0);

  // --------------------------------------------------------- the dashboard ---
  section('The dashboard, with real data');
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  check('it is no longer empty', (await page.getByText('No members yet').count()) === 0);
  check('members are counted', (await page.getByText('Active members').count()) > 0);
  check('money is counted', (await page.getByText('Collected').count()) > 0);
  check('the attendance is counted', (await page.getByText('In today').count()) > 0);

  // The charts are client-side Recharts: an SVG means the JavaScript ran.
  await page.waitForSelector('svg.recharts-surface', { timeout: 15_000 });
  const charts = await page.locator('svg.recharts-surface').count();
  check('the charts actually render', charts >= 2, `${charts} found`);

  // The date filter writes to the URL and the server recounts.
  await page.selectOption('select', 'thisMonth');
  await page.waitForURL(/range=thisMonth/, { timeout: 15_000 });
  check('the date filter is in the URL, so it survives a refresh', true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  check(
    'and the server honours it',
    (await page.getByText('This month').count()) > 0,
  );

  // ---------------------------------------------------------- the members ---
  section('The members list');
  await page.goto(`${BASE}/members`, { waitUntil: 'domcontentloaded' });
  check('the member is listed', (await page.getByText(member.firstName).count()) > 0);

  await page.fill('input[type="search"]', 'Nobody By This Name');
  await page.waitForFunction(
    () => document.body.innerText.includes('Nobody matches that'),
    undefined,
    { timeout: 15_000 },
  );
  check('search filters server-side and says when nothing matches', true);

  // ----------------------------------------------------------- editing ---
  section('Editing a member');
  await page.goto(`${memberUrl}/edit`, { waitUntil: 'domcontentloaded' });
  check('the edit page opens', (await page.locator('#field-firstName').count()) > 0);

  await page.fill('#field-email', 'ravi.kulkarni@example.com');
  await page.fill('#field-city', 'Chhatrapati Sambhajinagar');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await page.waitForURL((url) => !url.pathname.endsWith('/edit'), { timeout: 20_000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  check(
    'the change is saved and shown',
    (await page.getByText('ravi.kulkarni@example.com').count()) > 0,
  );
  check(
    'and so is the address',
    (await page.getByText(/Chhatrapati Sambhajinagar/).count()) > 0,
  );

  // ---------------------------------------------------------- invoices ---
  section('Invoices');
  await page.goto(`${BASE}/finance/invoices`, { waitUntil: 'domcontentloaded' });
  check('the invoices page renders', (await page.getByRole('heading', { name: 'Invoices' }).count()) > 0);
  check(
    'the invoice raised by the sale is listed',
    (await page.getByText(/INV\/\d{4}-\d{2}\/\d{5}/).count()) > 0,
  );
  check('it is marked paid', (await page.getByText('paid').count()) > 0);

  // The PDF is the deliverable a member actually asks for. Fetched through
  // the page so the session cookie and the route's auth both apply.
  const pdf = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/finance/invoices')).json();
    const id = list.data?.[0]?.id;
    if (!id) return { ok: false, reason: 'no invoice' };

    const response = await fetch(`/api/v1/finance/invoices/${id}/pdf`);
    const buffer = await response.arrayBuffer();
    const head = new TextDecoder('latin1').decode(buffer.slice(0, 5));
    return {
      ok: response.ok,
      status: response.status,
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      cache: response.headers.get('cache-control'),
      bytes: buffer.byteLength,
      head,
    };
  });

  check('the PDF downloads', pdf.ok === true, `status ${pdf.status}`);
  check('it is really a PDF', pdf.head === '%PDF-', String(pdf.head));
  check('of a believable size', pdf.bytes > 3000, `${pdf.bytes} bytes`);
  check('served as application/pdf', pdf.type === 'application/pdf', String(pdf.type));
  check(
    'named after the invoice, not "invoice.pdf"',
    /INV-\d{4}-\d{2}-\d{5}\.pdf/.test(pdf.disposition ?? ''),
    String(pdf.disposition),
  );
  check(
    'and never held by a shared cache',
    (pdf.cache ?? '').includes('no-store'),
    String(pdf.cache),
  );

  // ----------------------------------------------------- subscriptions ---
  section('Subscriptions');
  await page.goto(`${BASE}/memberships/subscriptions`, { waitUntil: 'domcontentloaded' });
  check(
    'the subscriptions page renders',
    (await page.getByRole('heading', { name: 'Subscriptions' }).count()) > 0,
  );
  check(
    'the membership is listed under the member’s full name',
    (await page.getByText(`${member.firstName} ${member.lastName}`).count()) > 0,
  );

  // Freeze, from the row, the way a receptionist would with the member there.
  await page.getByRole('button', { name: 'Freeze' }).first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes('days left on this plan'),
    undefined,
    { timeout: 10_000 },
  );
  check('the freeze panel says how much allowance is left', true);

  const dates = page.locator('input[type="date"]');
  const freezeFrom = new Date();
  const freezeTo = new Date(Date.now() + 6 * 86400000);
  await dates.nth(0).fill(freezeFrom.toISOString().slice(0, 10));
  await dates.nth(1).fill(freezeTo.toISOString().slice(0, 10));
  await page.getByRole('button', { name: 'Confirm' }).click();

  await page.waitForFunction(
    () => document.body.innerText.includes('frozen'),
    undefined,
    { timeout: 20_000 },
  );
  check('freezing works from the row', true);
  check('and the days used are shown', (await page.getByText(/7\/\d+d frozen/).count()) > 0);
  // The row must still be on screen: it was frozen, not ended, and the person
  // who froze it is still talking to the member.
  check(
    'the row stays in view after being frozen',
    (await page.getByText(`${member.firstName} ${member.lastName}`).count()) > 0,
  );

  // An extension with no reason must be refused by the form itself. Reload
  // first: the row's action buttons are replaced by whichever panel is open.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Extend' }).first().click();
  const confirmDisabled = await page.getByRole('button', { name: 'Confirm' }).isDisabled();
  check('an extension cannot be confirmed without a reason', confirmDisabled);

  // ---------------------------------------------------- importing a list ---
  section('Importing a member list');
  await page.goto(`${BASE}/members/import`, { waitUntil: 'domcontentloaded' });
  check(
    'the import page renders',
    (await page.getByRole('heading', { name: 'Import members' }).count()) > 0,
  );

  // A file like the ones gyms actually have: a country code, a leading zero,
  // a row with no name, a repeated number, and a blank line in the middle.
  const importCsv = [
    'Member Name,Mobile No,Email ID,DOJ,City',
    'Meera Nair,9845000001,meera@example.com,15/03/2024,Pune',
    'Rahul Verma,+91 9845000002,,01/04/2024,Mumbai',
    'Kiran Rao,09845000003,kiran@example.com,,Nashik',
    ',9845000004,,,Pune',
    '',
    'Deepa Shah,9845000001,deepa@example.com,,Pune',
    'Arun Mehta,9845000005,arun@example.com,20/05/2024,Pune',
  ].join('\n');

  await page.setInputFiles('#import-file', {
    name: 'members.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(importCsv, 'utf8'),
  });

  await page.waitForFunction(
    () => document.body.innerText.includes('Ready to import'),
    undefined,
    { timeout: 20_000 },
  );
  check('the file is read and counted before anything is created', true);

  const counts = await page.evaluate(() => {
    const text = document.body.innerText;
    const read = (label) => {
      const index = text.indexOf(label);
      if (index < 0) return null;
      const after = text.slice(index + label.length, index + label.length + 20);
      const match = /\d[\d,]*/.exec(after);
      return match ? Number(match[0].replace(/,/g, '')) : null;
    };
    return {
      ready: read('Ready to import'),
      duplicates: read('Already members'),
      invalid: read('Need fixing'),
    };
  });

  check('four good rows are counted', counts.ready === 4, JSON.stringify(counts));
  check('the repeated number is flagged, not imported', counts.duplicates === 1, JSON.stringify(counts));
  check('the nameless row is flagged', counts.invalid === 1, JSON.stringify(counts));

  check(
    'the columns were worked out from the headings',
    (await page.getByText('Mobile No').count()) > 0,
  );
  check(
    'and the preview shows rows as they would be imported',
    (await page.getByText('Meera').count()) > 0,
  );

  // Nothing exists yet — the whole point of the preview.
  const beforeCommit = await page.evaluate(async () => {
    const r = await fetch('/api/v1/members?pageSize=100&search=Meera');
    return (await r.json()).meta?.total ?? 0;
  });
  check('nothing is created until the gym says so', beforeCommit === 0, String(beforeCommit));

  await page.getByRole('button', { name: /^Import 4 members$/ }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('members imported'),
    undefined,
    { timeout: 30_000 },
  );
  check('the import completes', true);

  await page.goto(`${BASE}/members?q=Nair`, { waitUntil: 'domcontentloaded' });
  check(
    'the imported member is on the members list',
    (await page.getByText('Meera Nair').count()) > 0,
  );

  const imported = await page.evaluate(async () => {
    const r = await fetch('/api/v1/members?pageSize=100&search=9845');
    const body = await r.json();
    return { total: body.meta?.total ?? 0, first: body.data?.[0] ?? null };
  });
  check('all four are there, and only four', imported.total === 4, String(imported.total));
  check(
    'with a member code allocated',
    /^M\d{5}$/.test(imported.first?.memberCode ?? ''),
    String(imported.first?.memberCode),
  );

  // --------------------------------------------------------- the receipt ---
  section('Payment receipts');
  await page.goto(`${BASE}/finance/payments`, { waitUntil: 'domcontentloaded' });

  const receipt = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/finance/payments')).json();
    const id = list.data?.[0]?.id;
    if (!id) return { ok: false, reason: 'no payment' };

    const response = await fetch(`/api/v1/finance/payments/${id}/receipt`);
    const buffer = await response.arrayBuffer();
    return {
      ok: response.ok,
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      cache: response.headers.get('cache-control'),
      bytes: buffer.byteLength,
      head: new TextDecoder('latin1').decode(buffer.slice(0, 5)),
    };
  });

  check('the receipt downloads', receipt.ok === true, String(receipt.reason ?? ''));
  check('it is really a PDF', receipt.head === '%PDF-', String(receipt.head));
  check('served as application/pdf', receipt.type === 'application/pdf', String(receipt.type));
  check(
    'named after the receipt number',
    /RCP-\d{4}-\d{2}-\d{5}\.pdf/.test(receipt.disposition ?? ''),
    String(receipt.disposition),
  );
  check(
    'and never held by a shared cache',
    (receipt.cache ?? '').includes('no-store'),
    String(receipt.cache),
  );

  // --------------------------------------------------------- expenses ---
  section('Expenses');
  await page.goto(`${BASE}/finance/expenses`, { waitUntil: 'domcontentloaded' });
  check(
    'the expenses page renders',
    (await page.getByRole('heading', { name: 'Expenses' }).count()) > 0,
  );
  check(
    'and says plainly that nothing is recorded yet',
    (await page.getByText('Nothing recorded yet').count()) > 0,
  );

  await page.getByRole('button', { name: 'Record an expense' }).click();
  await page.fill('#exp-title', 'Shop rent — November');
  await page.fill('#exp-amount', '25000');
  await page.fill('#exp-tax', '4500');
  await page.selectOption('#exp-category', { label: 'Rent' });
  await page.selectOption('#exp-method', 'BANK_TRANSFER');
  await page.fill('#exp-reference', 'NEFT-99182');

  check(
    'the button shows the total, cost plus tax',
    (await page.getByRole('button', { name: /Record ₹29,500\.00/ }).count()) > 0,
  );

  await page.getByRole('button', { name: /Record ₹29,500\.00/ }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Shop rent'),
    undefined,
    { timeout: 20_000 },
  );
  check('the expense is recorded and listed', true);
  check('with its category', (await page.getByText('Rent').count()) > 0);
  check(
    'the tax is kept separate, as input credit needs',
    (await page.getByText('₹4,500.00').count()) > 0,
  );

  // The dashboard's net figure now has something to subtract.
  await page.goto(`${BASE}/dashboard?range=today`, { waitUntil: 'domcontentloaded' });
  const net = await page.evaluate(async () => {
    const r = await fetch('/api/v1/dashboard?range=thisMonth');
    return (await r.json()).data?.money ?? null;
  });
  check('the dashboard counts the spend', Number(net?.expensesInRange) === 29500, JSON.stringify(net));
  check(
    'and net is collected minus spent, not just collected',
    Number(net?.netInRange) === Number(net?.collectedInRange) - Number(net?.expensesInRange),
    JSON.stringify(net),
  );

  // ------------------------------------------------------------- the CSP ---
  section('Security headers');
  const response = await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' });
  const headers = response.headers();
  check('a nonce-based CSP is set', (headers['content-security-policy'] ?? '').includes('nonce-'));
  check('the page is not framable', (headers['x-frame-options'] ?? '').toLowerCase() === 'deny');
  check(
    'no MIME sniffing',
    (headers['x-content-type-options'] ?? '') === 'nosniff',
  );
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL threw — ${error.message}`);
  await page.screenshot({ path: '/tmp/phase2-failure.png', fullPage: true }).catch(() => {});
  console.log('  screenshot: /tmp/phase2-failure.png');
} finally {
  section('Console and network');
  check(
    'no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | '),
  );
  check(
    'nothing returned an error status',
    badResponses.length === 0,
    badResponses.slice(0, 5).join(' | '),
  );

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
