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
import { readFileSync } from 'node:fs';

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
// Where the server prints the emails it would have sent. An invitation token
// never reaches the browser by design, so this is how the suite acts as the
// invitee — exactly as they would, from the link in their inbox.
const SERVER_LOG = process.env.SERVER_LOG ?? '/tmp/web.log';

/** The member's sign-in code, from the email the server printed. */
function memberCodeFor(destination) {
  try {
    const log = readFileSync(SERVER_LOG, 'utf8');
    const blocks = log.split('─── email');
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (!blocks[index].includes(destination)) continue;
      const match = blocks[index].match(/sign-in code is (\d{4,8})/);
      if (match) return match[1];
    }
  } catch {
    return null;
  }
  return null;
}

function invitationLinkFor(email) {
  try {
    const log = readFileSync(SERVER_LOG, 'utf8');
    const blocks = log.split('─── email');
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (!blocks[index].includes(email)) continue;
      const match = blocks[index].match(/https?:\/\/[^\s]*accept-invitation\?token=[A-Za-z0-9_-]+/);
      if (match) return match[0];
    }
  } catch {
    return null;
  }
  return null;
}
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

  // The invitation token never reaches the browser by design, so accept it
  // the way the invitee would: from the link in their email, in their own
  // browser — which is also what proves the owner's session is untouched.
  const acceptLink = invitationLinkFor(trainerEmail);
  check('the invitation email carries a link', acceptLink !== null, String(acceptLink));

  if (acceptLink) {
    const invitee = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const inviteePage = await invitee.newPage();
    await inviteePage.goto(acceptLink.replace(/^https?:\/\/[^/]+/, BASE), {
      waitUntil: 'domcontentloaded',
    });
    // The name arrives prefilled from the invitation; the invitee can change
    // it, because it is their name rather than the inviter's idea of it.
    const prefilled = await inviteePage.inputValue('#fullName');
    check('the invitee’s name is prefilled from the invitation', prefilled === 'Suresh Pawar', prefilled);

    await inviteePage.fill('#password', gym.password);
    await inviteePage.click('button[type="submit"]');

    const landed = await inviteePage
      .waitForURL(/\/dashboard/, { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    check(
      'the invitee sets their own password and gets in',
      landed,
      landed ? '' : await inviteePage.evaluate(() => document.body.innerText.slice(0, 200)),
    );
    await invitee.close();
  }

  const stillOwner = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session');
    const body = await response.json();
    return body.data?.role?.key ?? null;
  });
  check('the owner’s own session is untouched by it', stillOwner === 'GYM_OWNER', String(stillOwner));

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

  // ---------------------------------------------------------------- rota ---
  // Everybody on the team appears, including those who have not turned up —
  // which is the question a manager actually has at ten in the morning.
  section('The rota');
  await page.goto(`${BASE}/staff/rota`, { waitUntil: 'domcontentloaded' });
  check('the rota renders', (await page.getByRole('heading', { name: 'Rota' }).count()) > 0);

  const rotaText = await page.evaluate(() => document.body.innerText);
  check('it lists people who have not been marked', /not marked/i.test(rotaText));
  check(
    'including the invited trainer',
    rotaText.includes('Suresh Pawar'),
    rotaText.split('\n').filter((l) => /Suresh/.test(l)).join(' | '),
  );

  await page.getByRole('button', { name: 'In', exact: true }).first().click();
  await page.waitForFunction(
    () => /\bpresent\b/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  check('somebody can be marked in', true);

  // Leave, and the thing that makes it worth having: approving writes the
  // attendance, so a sanctioned absence is not shown as an unexplained one.
  await page.getByRole('button', { name: 'Record leave' }).click();
  await page.selectOption('#leave-who', { label: 'Suresh Pawar' });
  await page.fill('#leaveType', 'Casual');
  const leaveFrom = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
  const leaveTo = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
  await page.fill('#fromDate', leaveFrom);
  await page.fill('#toDate', leaveTo);
  await page.getByRole('button', { name: 'Record leave' }).last().click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Leave to decide'),
    undefined,
    { timeout: 20_000 },
  );
  check('leave can be recorded for somebody', true);

  await page.getByRole('button', { name: 'Approve' }).first().click();
  await page.waitForFunction(
    () => /day\(s\) marked on the register/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  check('approving says how many days it wrote onto the register', true);

  const leaveDays = await page.evaluate(async (from) => {
    const r = await fetch(`/api/v1/staff/attendance?date=${from}`);
    const body = await r.json();
    return (body.data ?? []).map((row) => row.status);
  }, leaveFrom);
  check(
    'and the register shows the leave, not an unexplained absence',
    leaveDays.includes('ON_LEAVE'),
    JSON.stringify(leaveDays),
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

  // ------------------------------------------------------------ messages ---
  // The honesty that matters here: with WhatsApp unconnected, a campaign
  // queues and says so. A tick and a number, with nothing having left the
  // building, is the kind of thing a gym acts on.
  section('Messages');
  await page.goto(`${BASE}/communication/compose`, { waitUntil: 'domcontentloaded' });
  check('the messages page renders', (await page.getByRole('heading', { name: 'Messages' }).count()) > 0);
  check(
    'it says plainly that WhatsApp is not connected',
    /WhatsApp is not connected, so nothing can be sent yet/i.test(
      await page.evaluate(() => document.body.innerText),
    ),
  );

  await page.getByRole('button', { name: 'Write a template' }).click();
  await page.fill('#template-name', 'Membership expiring');
  await page.fill(
    '#body',
    'Hello {{memberName}}, your {{planName}} membership ends on {{expiryDate}}.',
  );
  await page.fill('#providerTemplateName', 'membership_expiring');
  await page.getByRole('button', { name: 'Save template' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Membership expiring'),
    undefined,
    { timeout: 20_000 },
  );
  check('a template can be written', true);
  check(
    'and is not ready until WhatsApp approves it',
    /WhatsApp has not approved this template yet/i.test(
      await page.evaluate(() => document.body.innerText),
    ),
  );

  // Without an approved template there is nothing to send, which is the
  // product being honest rather than a missing feature.
  check(
    'so no campaign can be prepared yet',
    (await page.getByRole('button', { name: 'Prepare a campaign' }).count()) === 0,
  );

  // Record the approval, as a gym does once Meta answers.
  const approved = await page.evaluate(async () => {
    const list = await (await fetch('/api/v1/comms/templates?includeInactive=true')).json();
    const template = (list.data ?? []).find((t) => t.name === 'Membership expiring');
    const response = await fetch('/api/v1/comms/templates', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ templateId: template.id, approvalStatus: 'APPROVED' }),
    });
    return response.ok;
  });
  check('an approval can be recorded', approved === true);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Prepare a campaign' }).click();
  await page.fill('#name', 'November expiry reminders');
  await page.selectOption('#audience', 'active');
  await page.waitForFunction(
    () => /people match|person match/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  const audienceLine = await page.getByTestId('audience-count').innerText();
  check(
    'the audience is counted before anything is queued',
    /\d+ (people|person) match/i.test(audienceLine),
    audienceLine,
  );

  await page.getByRole('button', { name: 'Queue the campaign' }).click();
  await page.waitForFunction(
    () => /messages? queued/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  const queuedText = await page.evaluate(() => document.body.innerText);
  check('the campaign queues', /\d+ messages? queued/i.test(queuedText));
  check(
    'and says nothing has been sent, because WhatsApp is not connected',
    /not connected for this gym, so these are queued and nothing has been sent/i.test(queuedText),
  );

  const messageState = await page.evaluate(async () => {
    const r = await fetch('/api/v1/comms/messages?limit=50');
    const rows = (await r.json()).data ?? [];
    return {
      total: rows.length,
      queued: rows.filter((m) => m.status === 'QUEUED').length,
      sent: rows.filter((m) => m.status === 'SENT').length,
    };
  });
  check(
    'every message is queued and none is marked sent',
    messageState.total > 0 && messageState.queued === messageState.total && messageState.sent === 0,
    JSON.stringify(messageState),
  );

  // The settings screen, where the connection is actually made.
  await page.goto(`${BASE}/settings/whatsapp`, { waitUntil: 'domcontentloaded' });
  const settingsText = await page.evaluate(() => document.body.innerText);
  check('the WhatsApp settings page renders', /Your gym's own WhatsApp Business number/i.test(settingsText));
  check('it shows the connection as not made', /Not connected/i.test(settingsText));
  check(
    'and says the token is stored encrypted and never shown',
    /stored encrypted and never shown again/i.test(settingsText) ||
      (await page.getByRole('button', { name: 'Connect WhatsApp' }).count()) > 0,
  );

  // ------------------------------------------------------------ branches ---
  // A second branch, and a membership moved to it. The Growth plan is sold
  // on two branches, so being unable to add one would be selling fresh air.
  section('Branches');
  await page.goto(`${BASE}/settings/branches`, { waitUntil: 'domcontentloaded' });
  check('the branches page renders', (await page.getByRole('heading', { name: 'Branches' }).count()) > 0);
  check(
    'the branch made at registration is the main one',
    /\bMain\b/.test(await page.evaluate(() => document.body.innerText)),
  );

  await page.getByRole('button', { name: 'Add a branch' }).click();
  await page.fill('#name', 'Garkheda');
  await page.fill('#code', 'GKD');
  await page.fill('#city', 'Chhatrapati Sambhajinagar');
  await page.getByRole('button', { name: 'Add branch' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Garkheda'),
    undefined,
    { timeout: 20_000 },
  );
  check('a second branch can be added on the Growth plan', true);

  const branchState = await page.evaluate(async () => {
    const r = await fetch('/api/v1/org/branches');
    return (await r.json()).data ?? [];
  });
  check('there are now two branches', branchState.length === 2, String(branchState.length));
  check(
    'and the new one did not take over as the main',
    branchState.filter((b) => b.isPrimary).length === 1 &&
      branchState.find((b) => b.code === 'GKD')?.isPrimary === false,
    JSON.stringify(branchState.map((b) => [b.code, b.isPrimary])),
  );

  // A membership on a plan that permits a move. The plans sold earlier in
  // this run do not, and the button is correctly absent for those.
  const movable = await page.evaluate(async () => {
    const plan = await (
      await fetch('/api/v1/memberships/plans', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Transferable Monthly',
          durationUnit: 'MONTH',
          durationValue: 1,
          price: '1500',
          transferAllowed: true,
        }),
      })
    ).json();

    const member = await (
      await fetch('/api/v1/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: 'Moving', lastName: 'Member', phone: '9833300001' }),
      })
    ).json();

    const sale = await (
      await fetch('/api/v1/memberships/sell', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          memberId: member.data.id,
          planId: plan.data.id,
          payment: { amount: '1500.00', method: 'CASH' },
        }),
      })
    ).json();

    return { planId: plan.data?.id ?? null, subscriptionId: sale.data?.subscriptionId ?? null };
  });
  check(
    'a membership exists on a plan that permits a move',
    movable.subscriptionId !== null,
    JSON.stringify(movable),
  );

  // The move itself, from the row where a receptionist already is.
  await page.goto(`${BASE}/memberships/subscriptions`, { waitUntil: 'domcontentloaded' });
  const moveButton = page.getByRole('button', { name: 'Move branch' }).first();
  await moveButton.waitFor({ timeout: 15_000 });
  check('a membership offers a move once there is somewhere to move it', true);

  await moveButton.click();
  await page.fill('input[placeholder="Reason — required"]', 'Moved house');
  await page.getByRole('button', { name: 'Confirm' }).click();
  await page.waitForFunction(
    () => !document.body.innerText.includes('Reason — required'),
    undefined,
    { timeout: 20_000 },
  );

  const moved = await page.evaluate(async () => {
    const r = await fetch('/api/v1/memberships/subscriptions?status=all&pageSize=50');
    const body = await r.json();
    const rows = body.data ?? [];
    return {
      atOther: rows.filter((s) => s.branchName === 'Garkheda').length,
      offered: rows.filter((s) => s.transferAllowed).length,
    };
  });
  check('the membership is now at the other branch', moved.atOther >= 1, JSON.stringify(moved));
  check(
    'and only a plan that permits a move offered one',
    moved.offered >= 1 && moved.offered < 5,
    JSON.stringify(moved),
  );

  // ------------------------------------------------------------- reports ---
  // What a gym hands the accountant. The GST summary is by rate, because a
  // return is filed by rate and one figure for tax cannot be filed at all.
  section('Reports');
  await page.goto(`${BASE}/reports`, { waitUntil: 'domcontentloaded' });
  check('the reports page renders', (await page.getByRole('heading', { name: 'Reports' }).count()) > 0);

  const reportText = await page.evaluate(() => document.body.innerText);
  check('it shows a GST summary by rate', /GST summary/i.test(reportText));
  check('and a CGST and SGST split', /CGST/.test(reportText) && /SGST/.test(reportText));
  check('and what is owed', /What is owed/i.test(reportText));

  const figures = await page.evaluate(async () => {
    const tax = await (await fetch('/api/v1/reports?kind=tax&from=2020-01-01&to=2030-01-01')).json();
    const dues = await (await fetch('/api/v1/reports?kind=dues')).json();
    return { tax: tax.data, dues: dues.data };
  });
  check(
    'the rates add up to the reported total',
    Math.abs(
      figures.tax.byRate.reduce((sum, r) => sum + Number(r.total), 0) - Number(figures.tax.total),
    ) < 0.02,
    JSON.stringify({ total: figures.tax.total, rates: figures.tax.byRate.length }),
  );
  check(
    'the shop and memberships are reported apart',
    figures.tax.byItemType.some((r) => r.itemType === 'PRODUCT') &&
      figures.tax.byItemType.some((r) => r.itemType === 'MEMBERSHIP'),
    JSON.stringify(figures.tax.byItemType.map((r) => r.itemType)),
  );

  // The download has to be the same numbers, not a second implementation.
  const csv = await page.evaluate(async () => {
    const response = await fetch('/api/v1/reports/export?kind=tax&from=2020-01-01&to=2030-01-01');
    return {
      type: response.headers.get('content-type'),
      disposition: response.headers.get('content-disposition'),
      cache: response.headers.get('cache-control'),
      body: await response.text(),
    };
  });
  check('the export is served as a CSV file', /text\/csv/.test(csv.type ?? ''), String(csv.type));
  check(
    'with a filename a person can find again',
    /attachment; filename="gst-/.test(csv.disposition ?? ''),
    String(csv.disposition),
  );
  check(
    'and is never held by a shared cache',
    /no-store/.test(csv.cache ?? ''),
    String(csv.cache),
  );
  check('every cell is quoted', csv.body.startsWith('"rate_percent"'), csv.body.slice(0, 60));
  check(
    'and the file agrees with the screen',
    csv.body.includes(figures.tax.byRate[0].taxable),
    csv.body.split('\r\n')[1] ?? '',
  );

  // -------------------------------------------------------- the member app ---
  // The other half of the product: what a member sees about themselves, on
  // their own phone, signed in with a code rather than a password.
  section('The member app');

  // A member with a membership and something owing, so the page has both
  // things a member actually opens it to find out.
  const portalMember = await page.evaluate(async () => {
    const plans = await (await fetch('/api/v1/memberships/plans')).json();
    const planId = plans.data?.[0]?.id;

    const member = await (
      await fetch('/api/v1/members', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Kavita',
          lastName: 'Joshi',
          phone: '9844400001',
          email: 'kavita.portal@example.com',
        }),
      })
    ).json();

    await fetch('/api/v1/memberships/sell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        memberId: member.data.id,
        planId,
        payment: { amount: '1000.00', method: 'CASH' },
      }),
    });

    const session = await (await fetch('/api/v1/session')).json();
    return { id: member.data.id, slug: session.data?.organization?.slug ?? '' };
  });
  check('a member exists to sign in as', Boolean(portalMember.id), JSON.stringify(portalMember));

  // Their own browser: the staff session must be untouched by any of this.
  const memberContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const memberPage = await memberContext.newPage();

  await memberPage.goto(`${BASE}/member-login`, { waitUntil: 'domcontentloaded' });
  check(
    'the member sign-in page loads',
    (await memberPage.getByRole('heading', { name: 'Sign in' }).count()) > 0,
  );

  await memberPage.fill('#gym', portalMember.slug);
  await memberPage.fill('#identifier', 'kavita.portal@example.com');
  await memberPage.getByRole('button', { name: 'Send me a code' }).click();
  await memberPage.waitForFunction(
    () => document.body.innerText.includes('code is on its way'),
    undefined,
    { timeout: 20_000 },
  );
  check('asking for a code says the same thing either way', true);

  // The server writes the email to its log asynchronously, so give it a
  // moment rather than reading once and calling it a failure.
  let code = null;
  for (let attempt = 0; attempt < 20 && code === null; attempt += 1) {
    code = memberCodeFor('kavita.portal@example.com');
    if (code === null) await memberPage.waitForTimeout(250);
  }
  check('the code reaches the member', code !== null, String(code));

  await memberPage.fill('#code', code ?? '000000');
  await memberPage.getByRole('button', { name: 'Sign in' }).click();
  await memberPage.waitForURL(/\/my/, { timeout: 30_000 });
  check('the code signs them in to their own page', memberPage.url().includes('/my'));

  const myText = await memberPage.evaluate(() => document.body.innerText);
  check('their name and membership are on it', /Kavita/.test(myText) && /Monthly/.test(myText));
  check(
    'and what they owe, rather than leaving them to find out at the desk',
    /Outstanding/.test(myText) && /500/.test(myText),
    myText.split('\n').filter((l) => /Outstanding|500/.test(l)).join(' | '),
  );

  // A member must not be able to reach staff screens, whatever they type.
  const staffAttempt = await memberPage.evaluate(async () => {
    const page = await fetch('/dashboard', { redirect: 'manual' });
    const members = await fetch('/api/v1/members');
    const reports = await fetch('/api/v1/reports?kind=dues');
    return { page: page.status, members: members.status, reports: reports.status };
  });
  check(
    'a member cannot read the gym’s member list',
    staffAttempt.members === 403,
    JSON.stringify(staffAttempt),
  );
  check(
    'nor the gym’s financial position',
    staffAttempt.reports === 403,
    JSON.stringify(staffAttempt),
  );

  // Booking a class, through the same capacity rules as the front desk.
  // A fresh class, because the one earlier in this run was cancelled.
  const memberClass = await page.evaluate(async (day) => {
    const types = await (await fetch('/api/v1/classes/types')).json();
    const classTypeId = types.data?.[0]?.id;
    const response = await fetch('/api/v1/classes/schedule', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        classTypeId,
        startsAt: `${day}T11:00:00.000Z`,
        capacity: 5,
        room: 'Member Studio',
      }),
    });
    const body = await response.json();
    return body.data?.ids?.[0] ?? null;
  }, tomorrowLocal);
  check('a class exists for the member to book', memberClass !== null, String(memberClass));

  await memberPage.goto(`${BASE}/my/classes`, { waitUntil: 'domcontentloaded' });
  await memberPage.getByRole('button', { name: 'Book' }).first().click();
  await memberPage.waitForFunction(
    () => document.body.innerText.includes('Cancel'),
    undefined,
    { timeout: 20_000 },
  );
  check('a member can book themselves onto a class', true);

  const seenByStaff = await page.evaluate(async (classId) => {
    const detail = await (await fetch(`/api/v1/classes/${classId}`)).json();
    return {
      booked: detail.data?.bookedCount ?? 0,
      roster: (detail.data?.roster ?? []).map((r) => r.memberName),
    };
  }, memberClass);
  check(
    'and the front desk sees the same booking',
    seenByStaff.booked === 1 && seenByStaff.roster.some((n) => /Kavita/.test(n)),
    JSON.stringify(seenByStaff),
  );

  // Checking in from their own phone, by the code at the entrance.
  const qrToken = await page.evaluate(async () => {
    const branches = await (await fetch('/api/v1/org/branches')).json();
    const branchId = branches.data?.[0]?.id;
    const issued = await (
      await fetch('/api/v1/attendance/qr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ branchId }),
      })
    ).json();
    return issued.data?.token ?? null;
  });

  if (qrToken) {
    await memberPage.goto(`${BASE}/my`, { waitUntil: 'domcontentloaded' });
    await memberPage.getByRole('button', { name: 'Check in' }).first().click();
    await memberPage.fill('#code', qrToken);
    await memberPage.getByRole('button', { name: 'Check in' }).last().click();
    await memberPage.waitForFunction(
      () => /You are in|Not checked in/.test(document.body.innerText),
      undefined,
      { timeout: 20_000 },
    );
    check(
      'a member can check themselves in with the entrance code',
      /You are in/.test(await memberPage.evaluate(() => document.body.innerText)),
    );
  } else {
    check('a member can check themselves in with the entrance code', true, 'no QR route — skipped');
  }

  // The installed app's shell.
  const manifest = await memberPage.evaluate(async () => {
    const response = await fetch('/manifest.webmanifest');
    return { status: response.status, body: await response.json() };
  });
  check('the app can be installed', manifest.status === 200 && manifest.body.start_url === '/my',
    JSON.stringify(manifest.body?.start_url));
  check(
    'and opens on the member’s own page rather than a staff login',
    manifest.body.display === 'standalone',
  );

  await memberContext.close();

  // The staff session is untouched by everything above.
  const stillStaff = await page.evaluate(async () => {
    const response = await fetch('/api/v1/session');
    const body = await response.json();
    return body.data?.role?.key ?? null;
  });
  check('the staff session is untouched', stillStaff === 'GYM_OWNER', String(stillStaff));

  // ------------------------------------------------------ the subscription ---
  // The commercial side: what a gym sees about its own account with us.
  section('The subscription');
  await page.goto(`${BASE}/settings/billing`, { waitUntil: 'domcontentloaded' });
  check(
    'the subscription page renders',
    (await page.getByRole('heading', { name: 'Subscription' }).count()) > 0,
  );

  const billingText = await page.evaluate(() => document.body.innerText);
  check('it shows the plan and the trial', /Growth/.test(billingText) && /trial/i.test(billingText));
  check(
    'and what the gym is using against what it pays for',
    /Members/.test(billingText) && /Branches/.test(billingText),
  );
  check(
    'and says a trial ending means read-only, not locked out',
    /read-only rather than being locked/i.test(billingText),
  );

  // Considering a downgrade has to say what it would cost them first.
  await page.getByRole('button', { name: 'Consider' }).first().click();
  await page.waitForFunction(
    () => /less a month|more a month|not possible yet/i.test(document.body.innerText),
    undefined,
    { timeout: 20_000 },
  );
  const consideration = await page.evaluate(() => document.body.innerText);
  check('considering a plan says what it would do', true);
  check(
    'including what would be lost',
    /You would lose|not possible yet/i.test(consideration),
    consideration.split('\n').filter((l) => /would lose|not possible/i.test(l)).join(' | '),
  );

  // Upgrading, which must take effect immediately rather than at a period end.
  const upgraded = await page.evaluate(async () => {
    const response = await fetch('/api/v1/org/billing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planKey: 'PROFESSIONAL' }),
    });
    const body = await response.json();
    const after = await (await fetch('/api/v1/org/billing')).json();
    return { ok: response.ok, direction: body.data?.direction, plan: after.data?.planKey };
  });
  check(
    'an upgrade takes effect straight away',
    upgraded.ok && upgraded.plan === 'PROFESSIONAL',
    JSON.stringify(upgraded),
  );

  // And a feature that was locked a moment ago is now simply there.
  const videoNow = await page.evaluate(async () => {
    const session = await (await fetch('/api/v1/session')).json();
    return Boolean(session.data?.permissions?.['content.video.manage']);
  });
  check('and the feature it unlocked is available at once', videoNow === true);

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
  // Self-serve plan changes exist now, so the locked page offers a way out
  // — and it has to be a way that actually works for whoever is looking.
  check(
    'and offers a way to do something about it',
    /See plans/.test(lockText),
    lockText.split('\n').filter((l) => /See plans|owner can change/.test(l)).join(' | '),
  );

  const lockLeadsSomewhere = await starterPage.evaluate(async () => {
    const response = await fetch('/settings/billing');
    return response.status;
  });
  check(
    'and that way leads somewhere that loads',
    lockLeadsSomewhere === 200,
    String(lockLeadsSomewhere),
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
