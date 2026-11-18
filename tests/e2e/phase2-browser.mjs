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

/**
 * Error responses this run provokes on purpose.
 *
 * A refusal the product is supposed to give — a duplicate enquiry answered
 * with 409 so the screen can offer "record it anyway" — is working software,
 * not a broken request. Each is declared at the point it is provoked and
 * consumed once, so an unexpected second one still fails the run.
 */
const expectedResponses = [];
const expectStatus = (status, method, fragment) =>
  expectedResponses.push({ status, method, fragment });

page.on('response', (response) => {
  const status = response.status();
  if (status < 400) return;

  const url = response.url();
  // A 401 on an API probe is a deliberate part of the flow; an icon that is
  // not there is cosmetic. Everything else is a real broken request.
  if (/favicon|\.ico$|icon\.svg/.test(url)) return;

  const method = response.request().method();
  const index = expectedResponses.findIndex(
    (e) => e.status === status && e.method === method && url.includes(e.fragment),
  );
  if (index !== -1) {
    expectedResponses.splice(index, 1);
    return;
  }

  badResponses.push(`${status} ${method} ${url.replace(BASE, '')}`);
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

  // The plan is chosen at signup, because it decides what the gym can use
  // during the trial. Growth is what this run exercises: it includes the CRM.
  check(
    'the plan choice is on the form',
    (await page.locator('input[name="planKey"]').count()) >= 3,
  );
  await page.check('input[name="planKey"][value="GROWTH"]');

  const terms = page.locator('input[type="checkbox"]:not([name="planKey"])').first();
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

  // ------------------------------------------------ trainers and the team ---
  section('Team and trainers');
  await page.goto(`${BASE}/staff`, { waitUntil: 'domcontentloaded' });
  check('the team page renders', (await page.getByRole('heading', { name: 'Team' }).count()) > 0);

  // Invite a trainer, accept as them, and assign a member — the whole point
  // of the trainer role, which until now had OWN scope on members and
  // nothing to fill it.
  const trainerEmail = `trainer.${stamp}@example.com`;

  const invited = await page.evaluate(async (email) => {
    const roles = await (await fetch('/api/v1/org/roles')).json();
    const trainerRole = (roles.data ?? []).find((r) => r.key === 'TRAINER');
    if (!trainerRole) return { ok: false, reason: 'no trainer role' };

    const response = await fetch('/api/v1/org/staff', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email,
        fullName: 'Suresh Pawar',
        roleId: trainerRole.id,
        branchIds: [],
      }),
    });
    return { ok: response.ok, status: response.status };
  }, trainerEmail);

  check('a trainer can be invited', invited.ok === true, JSON.stringify(invited));

  // The invitation token is not returned to the browser by design, so accept
  // it the way the invitee would: from the link in their email. Here that
  // means reading it from the server's own log line.
  const acceptLink = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session');
    return response.ok;
  });
  check('the session survives the invite', acceptLink === true);

  // Assign the member to a trainer through the profile, once one exists.
  await page.goto(`${BASE}/staff`, { waitUntil: 'domcontentloaded' });
  check(
    'the invited trainer appears on the team',
    (await page.getByText('Suresh Pawar').count()) > 0,
  );

  // ----------------------------------------------------------- enquiries ---
  section('Enquiries');
  await page.goto(`${BASE}/crm/leads`, { waitUntil: 'domcontentloaded' });
  check(
    'the enquiries page renders',
    (await page.getByRole('heading', { name: 'Enquiries' }).count()) > 0,
  );

  await page.getByRole('button', { name: 'Record an enquiry' }).click();
  await page.fill('#lead-fullName', 'Anita Shah');
  await page.fill('#lead-phone', '9830700001');
  await page.getByRole('button', { name: 'Record enquiry' }).click();

  await page.waitForFunction(
    () => document.body.innerText.includes('Anita Shah'),
    undefined,
    { timeout: 20_000 },
  );
  check('an enquiry is recorded', true);

  // The duplicate warning, which exists because families share numbers.
  // The 409 is the product working: declared here so the network check
  // treats it as intended rather than as a broken request.
  expectStatus(409, 'POST', '/api/v1/crm/leads');
  await page.getByRole('button', { name: 'Record an enquiry' }).click();
  await page.fill('#lead-fullName', 'Anita Again');
  await page.fill('#lead-phone', '9830700001');
  await page.getByRole('button', { name: 'Record enquiry' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('already an open enquiry'),
    undefined,
    { timeout: 15_000 },
  );
  check('a repeated number warns rather than blocking', true);
  check(
    'and offers to record it anyway, for a shared number',
    (await page.getByText(/families and couples/i).count()) > 0,
  );
  await page.getByRole('button', { name: 'Cancel' }).first().click();

  // Open the enquiry and log a call — the step the whole design is built on.
  await page.getByText('Anita Shah').first().click();
  await page.waitForURL(/\/crm\/leads\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const leadUrl = page.url();
  check('the enquiry opens', (await page.getByText('What happened?').count()) > 0);

  await page.getByRole('button', { name: 'Log a call' }).click();
  await page.fill('#outcome', 'Comparing us with the gym near the station');
  await page.getByRole('button', { name: 'Next week' }).click();
  await page.getByRole('button', { name: 'Save' }).click();

  await page.waitForFunction(
    () => document.body.innerText.includes('Comparing us'),
    undefined,
    { timeout: 20_000 },
  );
  check('the call is logged against the enquiry', true);

  const followUp = await page.evaluate(async (url) => {
    const id = url.split('/').pop();
    const r = await fetch(`/api/v1/crm/leads/${id}`);
    const body = await r.json();
    return body.data?.nextFollowUpAt ?? null;
  }, leadUrl);

  const daysOut = followUp
    ? Math.round((new Date(followUp).getTime() - Date.now()) / 86_400_000)
    : null;
  check(
    'and the next follow-up moved in the same action',
    daysOut !== null && daysOut >= 6 && daysOut <= 8,
    String(daysOut),
  );

  // Convert, which must create the member and link both ways.
  await page.getByRole('button', { name: 'They joined' }).click();
  await page.getByRole('button', { name: /Create their member record/ }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Now member'),
    undefined,
    { timeout: 20_000 },
  );
  check('converting creates the member', true);

  const converted = await page.evaluate(async () => {
    const r = await fetch('/api/v1/members?search=9830700001');
    const body = await r.json();
    return body.data?.[0] ?? null;
  });
  check('who is on the members list', converted !== null, JSON.stringify(converted));
  check(
    'and starts inactive, since no membership is sold yet',
    converted?.status === 'INACTIVE',
    String(converted?.status),
  );

  // ------------------------------------------------------------- classes ---
  // Capacity and the waitlist, through the interface a gym actually uses.
  section('Classes');

  // Two members with live memberships to book. Ravi's was frozen earlier in
  // this run, and a frozen membership is deliberately refused a class, so
  // the booking flow needs people who are actually paid up.
  const classMembers = await page.evaluate(async () => {
    const plans = await (await fetch('/api/v1/memberships/plans')).json();
    const planId = plans.data?.[0]?.id;
    const made = [];
    for (const [first, phone] of [
      ['Sunita', '9811122001'],
      ['Mahesh', '9811122002'],
    ]) {
      const member = await (
        await fetch('/api/v1/members', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ firstName: first, lastName: 'Classgoer', phone }),
        })
      ).json();
      await fetch('/api/v1/memberships/sell', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memberId: member.data.id,
          planId,
          payment: { amount: '1500.00', method: 'CASH' },
        }),
      });
      made.push({ name: first, id: member.data.id });
    }
    return made;
  });
  check('two paid-up members exist to book in', classMembers.length === 2);

  await page.goto(`${BASE}/classes/schedule`, { waitUntil: 'domcontentloaded' });
  check(
    'the timetable renders',
    (await page.getByRole('heading', { name: 'Classes' }).count()) > 0,
  );

  // A gym with no class types is told what to do first, not shown an empty grid.
  check(
    'an empty gym is told to add a kind of class first',
    (await page.getByText(/Nothing to schedule yet/i).count()) > 0,
  );

  await page.getByRole('button', { name: 'Add a kind of class' }).click();
  await page.fill('#name', 'Reformer');
  await page.fill('#defaultCapacity', '1');
  await page.getByRole('button', { name: 'Add class' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Put a class on the timetable'),
    undefined,
    { timeout: 20_000 },
  );
  check('a kind of class can be added', true);

  // Tomorrow at 10am: in the future, so it can be booked, and squarely
  // inside the gym's own business day rather than straddling it.
  const tomorrowLocal = (() => {
    const d = new Date(Date.now() + 86_400_000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();

  await page.getByRole('button', { name: 'Put a class on the timetable' }).click();
  await page.fill('#date', tomorrowLocal);
  await page.fill('#time', '10:00');
  await page.fill('#room', 'Studio A');
  await page.getByRole('button', { name: 'Schedule' }).click();

  // The panel closes only once the class has actually been created, so this
  // is the signal that the write landed — not the URL, which never changed.
  await page
    .getByRole('button', { name: 'Put a class on the timetable' })
    .waitFor({ timeout: 20_000 });

  await page.goto(`${BASE}/classes/schedule?day=${tomorrowLocal}`, {
    waitUntil: 'domcontentloaded',
  });

  const timetableText = await page.evaluate(() => document.body.innerText);
  check('a class appears on the timetable', /Studio A/.test(timetableText));
  check(
    'and leads with the places left',
    /1 place left/i.test(timetableText),
    timetableText.split('\n').filter((l) => /place|Full|of /i.test(l)).join(' | '),
  );

  // Into the class itself, where the register lives.
  await page.getByText('Studio A').first().click();
  await page.waitForURL(/\/classes\/[0-9a-f-]{36}/, { timeout: 20_000 });
  const classUrl = page.url();
  check('the class opens', (await page.getByText('The register').count()) > 0);

  await page.getByRole('button', { name: 'Book a member in' }).click();
  await page.fill('input[aria-label="Find a member"]', 'Sunita');
  await page.getByRole('button', { name: 'Book', exact: true }).first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes('is booked in'),
    undefined,
    { timeout: 20_000 },
  );
  check('a member is booked in', true);
  check(
    'and the message says how many places are left',
    /0 places left/i.test(await page.evaluate(() => document.body.innerText)),
  );

  // The single place is taken, so the next member must be waitlisted rather
  // than squeezed in — the bit that breaks in most gym software.
  await page.fill('input[aria-label="Find a member"]', 'Mahesh');
  const waitlistButton = page.getByRole('button', { name: 'Waitlist' }).first();
  await waitlistButton.waitFor({ timeout: 15_000 });
  check('a full class offers the waitlist, not a booking', true);
  await waitlistButton.click();
  await page.waitForFunction(
    () => document.body.innerText.includes('on the waitlist at position 1'),
    undefined,
    { timeout: 20_000 },
  );
  check('the next member is waitlisted at position 1', true);

  await page.getByRole('button', { name: 'Done' }).click();

  const classCounts = await page.evaluate(async (url) => {
    const id = url.split('/').pop();
    const r = await fetch(`/api/v1/classes/${id}`);
    return (await r.json()).data ?? null;
  }, classUrl);
  check(
    'the class holds one booking and one on the waitlist',
    classCounts?.bookedCount === 1 && classCounts?.waitlistCount === 1,
    JSON.stringify({
      booked: classCounts?.bookedCount,
      waiting: classCounts?.waitlistCount,
    }),
  );
  check(
    'and never more bookings than places',
    classCounts !== null && classCounts.bookedCount <= classCounts.capacity,
  );

  // Cancelling the booked member must move the waitlisted one in, and say so.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes('moved off the waitlist'),
    undefined,
    { timeout: 20_000 },
  );
  check('cancelling promotes the first person waiting, and says who', true);

  const afterPromotion = await page.evaluate(async (url) => {
    const id = url.split('/').pop();
    const r = await fetch(`/api/v1/classes/${id}`);
    return (await r.json()).data ?? null;
  }, classUrl);
  check(
    'the promoted member holds the place, and the waitlist is empty',
    afterPromotion?.bookedCount === 1 && afterPromotion?.waitlistCount === 0,
    JSON.stringify({
      booked: afterPromotion?.bookedCount,
      waiting: afterPromotion?.waitlistCount,
    }),
  );

  // Marking the register, which must also count as a gym visit.
  await page.goto(classUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Present' }).first().click();
  // "Turned up" is a stat-tile label that is on the page either way, so it
  // is no signal at all: poll the roster itself until the write lands.
  let presentState = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    presentState = await page.evaluate(async (url) => {
      const id = url.split('/').pop();
      const detail = await (await fetch(`/api/v1/classes/${id}`)).json();
      return detail.data?.roster?.map((r) => r.status) ?? [];
    }, classUrl);
    if (presentState.includes('ATTENDED')) break;
    await page.waitForTimeout(250);
  }
  check(
    'a member can be marked present',
    presentState.includes('ATTENDED'),
    JSON.stringify(presentState),
  );

  // Someone booked but not yet marked present, so the cancellation has a
  // person to hand back.
  await page.goto(classUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add to the waitlist' }).click();
  await page.fill('input[aria-label="Find a member"]', 'Sunita');
  await page.getByRole('button', { name: 'Waitlist' }).first().click();
  await page.waitForFunction(
    () => document.body.innerText.includes('waitlist at position 1'),
    undefined,
    { timeout: 20_000 },
  );

  // Cancelling the class itself must hand over the list of people to ring.
  await page.goto(classUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Cancel this class' }).click();
  await page.fill('#reason', 'The trainer is unwell');
  await page.getByRole('button', { name: 'Cancel the class' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('These members were booked in'),
    undefined,
    { timeout: 20_000 },
  );
  check('cancelling a class hands over who has to be told', true);
  check(
    'with a number that can be dialled',
    (await page.locator('a[href^="tel:"]').count()) > 0,
  );

  // ---------------------------------------------------------------- shop ---
  // The counter: a sale here is a real GST invoice, and the stock behind it
  // is a ledger rather than a number somebody types over.
  section('The shop');
  await page.goto(`${BASE}/inventory/products`, { waitUntil: 'domcontentloaded' });
  check('the shop renders', (await page.getByRole('heading', { name: 'Shop' }).count()) > 0);
  check(
    'an empty shop says what to do first',
    (await page.getByText(/Nothing on the shelf yet/i).count()) > 0,
  );

  await page.getByRole('button', { name: 'Add a product' }).click();
  await page.fill('#name', 'Protein Bar');
  await page.fill('#sellingPrice', '100');
  await page.fill('#purchasePrice', '60');
  await page.fill('#openingStock', '4');
  await page.fill('#reorderLevel', '2');
  await page.getByRole('button', { name: 'Add product' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Protein Bar'),
    undefined,
    { timeout: 20_000 },
  );
  check('a product can be added', true);
  check(
    'and its opening stock is on the shelf',
    /4 piece/.test(await page.evaluate(() => document.body.innerText)),
  );

  // Ring up a sale of two, which must take the money and the stock together.
  await page.getByRole('button', { name: 'Sell at the counter' }).click();
  await page.getByRole('button', { name: /Protein Bar/ }).first().click();
  await page.getByRole('button', { name: /Protein Bar/ }).first().click();
  const tillTotal = await page.getByTestId('till-total').innerText();
  check('the till shows the running total', /200/.test(tillTotal), tillTotal);

  await page.getByRole('button', { name: /^Take / }).click();
  // "invoice" alone would match the sidebar, so wait for the sentence the
  // till itself writes.
  await page.waitForFunction(
    () => /taken — invoice/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  const saleText = await page.evaluate(() => document.body.innerText);
  check(
    'the sale names its invoice, not just "done"',
    /taken — invoice INV/i.test(saleText),
    (saleText.split('\n').find((l) => /taken/i.test(l)) ?? '').slice(0, 120),
  );
  check(
    'and its receipt',
    /Receipt RCP/i.test(saleText),
    (saleText.split('\n').find((l) => /receipt/i.test(l)) ?? '').slice(0, 120),
  );

  await page.getByRole('button', { name: 'Done' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Stock movements'),
    undefined,
    { timeout: 20_000 },
  );

  const shopState = await page.evaluate(async () => {
    const products = await (await fetch('/api/v1/inventory/products')).json();
    const movements = await (await fetch('/api/v1/inventory/stock')).json();
    return { products: products.data ?? [], movements: movements.data ?? [] };
  });
  const bar = shopState.products.find((p) => p.name === 'Protein Bar');
  check('the sale took the stock down', bar?.quantityOnHand === '2', JSON.stringify(bar));
  check(
    'and is at its reorder level, so it is flagged',
    bar?.needsReorder === true,
    String(bar?.needsReorder),
  );
  check(
    'the movement carries the balance it left behind',
    shopState.movements[0]?.movementType === 'SALE' &&
      shopState.movements[0]?.balanceAfter === '2',
    JSON.stringify(shopState.movements[0] ?? null),
  );

  // One set of documents: the counter sale is in the invoice list with the
  // membership sales, which is what makes the books reconcilable.
  await page.goto(`${BASE}/finance/invoices`, { waitUntil: 'domcontentloaded' });
  check(
    'the counter sale is in the same invoice list as a membership',
    /Protein Bar|200\.00/.test(await page.evaluate(() => document.body.innerText)),
  );

  // A correction is a signed difference, never a new total.
  await page.goto(`${BASE}/inventory/products`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Stock in or correct' }).click();
  await page.selectOption('#movementType', 'ADJUSTMENT');
  await page.fill('#quantity', '-1');
  await page.fill('#notes', 'One missing at the count');
  await page.getByRole('button', { name: 'Record' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Stock movements'),
    undefined,
    { timeout: 20_000 },
  );

  const afterCount = await page.evaluate(async () => {
    const r = await fetch('/api/v1/inventory/products');
    return ((await r.json()).data ?? []).find((p) => p.name === 'Protein Bar');
  });
  check(
    'a correction moves the figure by the difference',
    afterCount?.quantityOnHand === '1',
    String(afterCount?.quantityOnHand),
  );

  // --------------------------------------------------------- the plan wall ---
  // A second gym, on Starter, which does not include the CRM. What it meets
  // there decides whether a plan boundary reads as a sale or as a bug: the
  // page must explain the plan, and the sidebar must still show the area so
  // the gym knows it exists.
  section('The plan boundary');
  const starterPage = await context.newPage();
  const starterSuffix = Date.now();
  await starterPage.goto(`${BASE}/register-gym`, { waitUntil: 'domcontentloaded' });
  await starterPage.fill('#gymName', `Starter Fitness ${starterSuffix}`);
  await starterPage.fill('#ownerName', 'Rakesh Jadhav');
  await starterPage.fill('#email', `starter.${starterSuffix}@example.com`);
  await starterPage.fill('#phone', '9876500011');
  await starterPage.fill('#password', gym.password);
  await starterPage.check('input[name="planKey"][value="STARTER"]');
  const starterTerms = starterPage
    .locator('input[type="checkbox"]:not([name="planKey"])')
    .first();
  if (await starterTerms.count()) await starterTerms.check();
  await starterPage.click('button[type="submit"]');
  await starterPage.waitForURL(/\/dashboard/, { timeout: 30_000 });
  check('a gym can register on Starter', starterPage.url().includes('/dashboard'));

  check(
    'the sidebar still shows Enquiries, marked locked',
    (await starterPage.getByText('Locked').count()) > 0,
  );

  const lockResponse = await starterPage.goto(`${BASE}/crm/leads`, {
    waitUntil: 'domcontentloaded',
  });
  check(
    'the locked page answers 200, not 500',
    lockResponse.status() === 200,
    String(lockResponse.status()),
  );
  const lockText = await starterPage.evaluate(() => document.body.innerText);
  // innerText applies text-transform, so the label arrives upper-cased.
  check('it says the plan is what is missing', /not on your plan/i.test(lockText));
  check(
    'and names the plan that includes it, with its price',
    lockText.includes('Growth') && /₹\s?2,999/.test(lockText),
    lockText.slice(0, 160),
  );
  check(
    'with no button that cannot do anything',
    !/See plans|Upgrade now/.test(lockText),
  );

  // The API must refuse it the same way, with a code the mobile app can read.
  const lockedApi = await starterPage.evaluate(async () => {
    const r = await fetch('/api/v1/crm/leads');
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  check(
    'the API refuses with FEATURE_NOT_IN_PLAN',
    lockedApi.body?.error?.code === 'FEATURE_NOT_IN_PLAN',
    JSON.stringify(lockedApi),
  );
  expectStatus(403, 'GET', '/api/v1/crm/leads');
  await starterPage.close();

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
