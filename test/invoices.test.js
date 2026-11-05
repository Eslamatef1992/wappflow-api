// Invoices sent to customers on WhatsApp: public API, dashboard, public invoice page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dbFile = path.join(os.tmpdir(), `wf-invoices-${Date.now()}.sqlite`);
let server; let base; let owner; let apiKey; let db;

before(async () => {
  Object.assign(process.env, { DB_FILE: dbFile, DB_CLIENT: '', MOCK_STATUS_DELAY_MS: '999999' });
  execFileSync('node', ['src/scripts/seed.js', '--demo'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });
  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@demo.local', password: 'demo12345' }) })).json()).token;
  apiKey = (await call('POST', '/api/app/api-keys', { name: 'POS' })).data.key;
});
after(async () => { server.close(); await db.destroy(); fs.rmSync(dbFile, { force: true }); });

async function call(method, url, body, auth = { Authorization: `Bearer ${owner}` }) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, type: res.headers.get('content-type') };
}
const api = (method, url, body) => call(method, url, body, { 'X-Api-Key': apiKey });

test('without a WhatsApp message set up, the invoice is saved and explains why it was not sent', async () => {
  const r = await api('POST', '/api/v1/invoices', { number: 'POS-1', phone: '+965 5111 0001', name: 'Ahmad Ali', total: 12.5, items: [{ name: 'Latte', quantity: 2, price: 1.75 }] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.number, 'POS-1');
  assert.equal(r.data.total, 12.5);
  assert.equal(r.data.status, 'unpaid');
  assert.match(r.data.link, /\/i\/[\w-]{16,}$/);
  assert.equal(r.data.whatsapp.sent, false);
  assert.match(r.data.whatsapp.error, /24 hours/);
  assert.equal(r.data.token, undefined);
});

test('inside the 24-hour window the invoice goes out as a normal message with its PDF', async () => {
  await db('contacts').where({ wa_id: '96551110001' }).update({ last_inbound_at: Date.now() });
  const r = await api('POST', '/api/v1/invoices', { number: 'POS-2', phone: '96551110001', total: 3, pdf_url: 'https://pos.example.com/POS-2.pdf' });
  assert.equal(r.data.whatsapp.sent, true, JSON.stringify(r.data));
  assert.equal(r.data.whatsapp.via, 'message');
  const msg = await db('messages').where({ id: r.data.whatsapp.message_id }).first();
  assert.equal(msg.type, 'document');
  assert.match(msg.content, /POS-2\.pdf/);
});

test('one-click template: new invoices are sent with the approved template and its link button', async () => {
  const setup = await call('POST', '/api/app/invoices-setup/recommended', { language: 'en' });
  assert.equal(setup.status, 201, JSON.stringify(setup.data));
  assert.equal(setup.data.template.status, 'APPROVED'); // mock number approves instantly

  const r = await api('POST', '/api/v1/invoices', { number: 'POS-3', phone: '+96551110003', name: 'Sara Ahmad', total: 7.25 });
  assert.equal(r.data.whatsapp.sent, true, JSON.stringify(r.data));
  assert.equal(r.data.whatsapp.via, 'automation');
  const msg = await db('messages').where({ id: r.data.whatsapp.message_id }).first();
  assert.match(msg.body, /Hello Sara, your invoice POS-3 from Demo Store is ready/);
  assert.match(msg.body, /7\.250 KWD/);
  const token = r.data.link.split('/i/')[1];
  const button = JSON.parse(msg.content).template.components.find((c) => c.type === 'button');
  assert.equal(button.parameters[0].text, token);
});

test('sending the same invoice number again does not send twice; resend does', async () => {
  const again = await api('POST', '/api/v1/invoices', { number: 'POS-3', phone: '+96551110003', total: 7.25 });
  assert.equal(again.status, 200);
  assert.equal(again.data.whatsapp, null);
  const resend = await api('POST', '/api/v1/invoices', { number: 'POS-3', phone: '+96551110003', resend: true });
  assert.equal(resend.data.whatsapp.sent, true);
});

test('public invoice page shows the invoice in English and Arabic; bad links 404', async () => {
  const inv = (await api('GET', '/api/v1/invoices/POS-1')).data;
  const en = await call('GET', new URL(inv.link).pathname, null, {});
  assert.equal(en.status, 200);
  assert.match(en.type, /html/);
  assert.match(en.data, /Demo Store/);
  assert.match(en.data, /POS-1/);
  assert.match(en.data, /Latte/);
  assert.match(en.data, /12\.500 KWD/);
  assert.match(en.data, /Unpaid/);
  const ar = await call('GET', `${new URL(inv.link).pathname}?lang=ar`, null, {});
  assert.match(ar.data, /dir="rtl"/);
  assert.match(ar.data, /غير مدفوعة/);
  assert.equal((await call('GET', '/i/not-a-real-token-123', null, {})).status, 404);
  assert.equal((await call('GET', '/i/<script>', null, {})).status, 404);
});

test('marking paid updates the invoice and the page', async () => {
  const r = await api('PATCH', '/api/v1/invoices/POS-1', { status: 'paid' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'paid');
  assert.ok(r.data.paid_at);
  const page = await call('GET', new URL(r.data.link).pathname, null, {});
  assert.match(page.data, /Paid/);
  assert.equal((await api('PATCH', '/api/v1/invoices/POS-1', { status: 'refunded' })).status, 400);
});

test('dashboard lists, creates and resends invoices', async () => {
  const list = await call('GET', '/api/app/invoices');
  assert.equal(list.status, 200);
  assert.equal(list.data.total, 3);
  const pos3 = list.data.data.find((i) => i.number === 'POS-3');
  assert.equal(pos3.contact_name, 'Sara Ahmad');
  assert.equal(pos3.message_status, 'sent');

  const made = await call('POST', '/api/app/invoices', { number: 'MAN-1', phone: '+96551110009', name: 'Omar', items: [{ name: 'Repair', quantity: 1, price: 20 }] });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.total, 20); // from items
  assert.equal(made.data.source, 'manual');
  assert.equal(made.data.whatsapp.sent, true);
  assert.equal((await call('POST', '/api/app/invoices', { number: 'MAN-1', phone: '+96551110009' })).status, 400);
  assert.equal((await call('POST', `/api/app/invoices/${made.data.id}/send`)).data.whatsapp.sent, true);
  assert.equal((await call('GET', '/api/app/invoices?q=Omar')).data.total, 1);

  const setup = await call('GET', '/api/app/invoices-setup');
  assert.equal(setup.data.data[0].event, 'invoice.created');
  assert.equal(setup.data.data[0].template_name, 'invoice_ready');
  // invoice messages do not appear in Commerce → Order updates
  assert.ok(!(await call('GET', '/api/app/automations')).data.data.some((a) => a.event.startsWith('invoice.')));
});

test('validation and API key required', async () => {
  assert.equal((await api('POST', '/api/v1/invoices', { phone: '+96551110001' })).status, 400);
  assert.equal((await api('POST', '/api/v1/invoices', { number: 'X', phone: 'abc' })).status, 400);
  assert.equal((await api('POST', '/api/v1/invoices', { number: 'X', phone: '+96551110001', pdf_url: 'http://insecure' })).status, 400);
  assert.equal((await call('POST', '/api/v1/invoices', { number: 'X', phone: '+96551110001' }, {})).status, 401);
  assert.equal((await api('GET', '/api/v1/invoices/NOPE')).status, 404);
});
