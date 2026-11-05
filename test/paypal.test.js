// PayPal invoice payments against a fake PayPal API (Orders v2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

// ---- fake PayPal ----
const orders = new Map();
let seq = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/v1/oauth2/token') {
      return req.headers.authorization === `Basic ${Buffer.from('cid:sec').toString('base64')}` ? send(200, { access_token: 'tok', expires_in: 3600 }) : send(401, {});
    }
    if (req.headers.authorization !== 'Bearer tok') return send(401, {});
    if (req.method === 'POST' && url.pathname === '/v2/checkout/orders') {
      const b = JSON.parse(body);
      const id = `ORDER${++seq}`;
      orders.set(id, { id, status: 'PAYER_ACTION_REQUIRED', purchase_units: b.purchase_units, _ctx: b.payment_source?.paypal?.experience_context });
      return send(201, { id, status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: `https://paypal.test/checkoutnow?token=${id}` }] });
    }
    const m = url.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (m) {
      const o = orders.get(m[1]);
      if (!o) return send(404, { name: 'RESOURCE_NOT_FOUND' });
      if (m[2]) {
        if (o.status !== 'APPROVED') return send(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
        o.status = 'COMPLETED';
        const u = o.purchase_units[0];
        u.payments = { captures: [{ id: `CAP-${o.id}`, status: 'COMPLETED', custom_id: u.custom_id, amount: o.captureOverride || u.amount }] };
      }
      return send(200, o);
    }
    send(404, {});
  });
});
const approve = (id) => { orders.get(id).status = 'APPROVED'; };

const dbFile = path.join(os.tmpdir(), `wf-paypal-${Date.now()}.sqlite`);
let server; let base; let owner; let admin;

before(async () => {
  await new Promise((r) => fake.listen(0, r));
  Object.assign(process.env, {
    DB_FILE: dbFile, DB_CLIENT: '', PAYPAL_CLIENT_ID: 'cid', PAYPAL_SECRET: 'sec',
    PAYPAL_API_BASE: `http://127.0.0.1:${fake.address().port}`, PAYPAL_CURRENCY: 'USD', PAYPAL_FX_RATE: '3.26',
  });
  execFileSync('node', ['src/scripts/seed.js', '--demo'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
  owner = await login('owner@demo.local', 'demo12345');
  admin = await login('admin@wappflow.local', 'admin12345');
});
after(async () => {
  server.close(); fake.close();
  const { db } = await import('../src/db.js'); await db.destroy();
  fs.rmSync(dbFile, { force: true });
});

const call = async (method, url, body, token = owner) => {
  const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, location: res.headers.get('location') };
};

async function newInvoice() {
  const plans = (await call('GET', '/api/app/billing')).data.plans;
  const business = plans.find((p) => p.slug === 'business');
  return (await call('POST', '/api/app/billing/subscribe', { planId: business.id })).data;
}

test('billing page offers PayPal with the converted amount', async () => {
  const inv = await newInvoice();
  const b = (await call('GET', '/api/app/billing')).data;
  assert.equal(b.paymentMethods.paypal, true);
  assert.deepEqual(b.paypalQuotes[inv.id], { currency: 'USD', value: '257.54', converted: true }); // 79 KWD × 3.26
});

test('pay with PayPal: approve, return, invoice paid and workspace active', async () => {
  const inv = await newInvoice();
  const pay = await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'paypal' });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  const orderId = new URL(pay.data.url).searchParams.get('token');
  assert.equal(orders.get(orderId).purchase_units[0].amount.value, '257.54');

  // returning before approval does not mark anything paid
  let ret = await call('GET', `/api/billing/paypal/return?token=${orderId}`, null, null);
  assert.match(ret.location, /payment=pending/);

  approve(orderId);
  ret = await call('GET', `/api/billing/paypal/return?token=${orderId}`, null, null);
  assert.equal(ret.status, 302);
  assert.match(ret.location, /\/app\/billing\?payment=success$/);

  const b = (await call('GET', '/api/app/billing')).data;
  const paid = b.invoices.find((i) => i.id === inv.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.provider, 'paypal');
  assert.equal(paid.provider_ref, `CAP-${orderId}`);
  assert.equal(b.tenant.status, 'active');
  assert.equal(b.subscription.status, 'active');

  // returning again (refresh) stays paid and does not double-extend
  const end1 = b.subscription.current_period_end;
  await call('GET', `/api/billing/paypal/return?token=${orderId}`, null, null);
  const again = (await call('GET', '/api/app/billing')).data;
  assert.equal(again.subscription.current_period_end, end1);
});

test('suspended workspace can still pay and is reactivated', async () => {
  const me = (await call('GET', '/api/auth/me')).data;
  await call('PATCH', `/api/admin/tenants/${me.tenant.id}`, { status: 'suspended' }, admin);
  assert.equal((await call('GET', '/api/app/contacts')).status, 402);
  const inv = await newInvoice();
  const pay = await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'paypal' });
  assert.equal(pay.status, 200);
  const orderId = new URL(pay.data.url).searchParams.get('token');
  approve(orderId);
  await call('GET', `/api/billing/paypal/return?token=${orderId}`, null, null);
  assert.equal((await call('GET', '/api/auth/me')).data.tenant.status, 'active');
  assert.equal((await call('GET', '/api/app/contacts')).status, 200);
});

test('webhook confirms a payment when the customer never came back', async () => {
  const inv = await newInvoice();
  const orderId = new URL((await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'paypal' })).data.url).searchParams.get('token');
  approve(orderId);
  const wh = await call('POST', '/api/billing/paypal/webhook', { event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: orderId } }, null);
  assert.equal(wh.status, 200);
  const paid = (await call('GET', '/api/app/billing')).data.invoices.find((i) => i.id === inv.id);
  assert.equal(paid.status, 'paid');
});

test('"I already paid" check captures an approved order', async () => {
  const inv = await newInvoice();
  const orderId = new URL((await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'paypal' })).data.url).searchParams.get('token');
  assert.equal((await call('POST', `/api/app/billing/invoices/${inv.id}/check`)).data.paid, false);
  approve(orderId);
  assert.equal((await call('POST', `/api/app/billing/invoices/${inv.id}/check`)).data.paid, true);
});

test('fake or tampered payments are rejected', async () => {
  // an order id we never created
  let ret = await call('GET', '/api/billing/paypal/return?token=ORDER-FAKE', null, null);
  assert.match(ret.location, /payment=pending/);
  // webhook body claiming success for an unknown order
  await call('POST', '/api/billing/paypal/webhook', { event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { supplementary_data: { related_ids: { order_id: 'ORDER-FAKE' } } } }, null);

  // captured amount lower than the invoice
  const inv = await newInvoice();
  const orderId = new URL((await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'paypal' })).data.url).searchParams.get('token');
  approve(orderId);
  orders.get(orderId).captureOverride = { currency_code: 'USD', value: '1.00' };
  ret = await call('GET', `/api/billing/paypal/return?token=${orderId}`, null, null);
  assert.match(ret.location, /payment=pending/);
  const still = (await call('GET', '/api/app/billing')).data.invoices.find((i) => i.id === inv.id);
  assert.equal(still.status, 'unpaid');
});

test('Visa / Mastercard opens PayPal guest card checkout and pays the same way', async () => {
  const b0 = (await call('GET', '/api/app/billing')).data;
  assert.equal(b0.paymentMethods.card, true);
  const inv = await newInvoice();
  const pay = await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'card' });
  assert.equal(pay.status, 200, JSON.stringify(pay.data));
  const orderId = new URL(pay.data.url).searchParams.get('token');
  assert.equal(orders.get(orderId)._ctx.landing_page, 'GUEST_CHECKOUT');
  const viaPaypal = await call('POST', `/api/app/billing/invoices/${inv.id}/pay`, { method: 'paypal' });
  assert.equal(orders.get(new URL(viaPaypal.data.url).searchParams.get('token'))._ctx.landing_page, 'LOGIN');
  approve(new URL(viaPaypal.data.url).searchParams.get('token'));
  await call('GET', `/api/billing/paypal/return?token=${new URL(viaPaypal.data.url).searchParams.get('token')}`, null, null);
  assert.equal((await call('GET', '/api/app/billing')).data.invoices.find((i) => i.id === inv.id).status, 'paid');
});

test('installer placeholder for bank details is never shown to customers', async () => {
  process.env.BANK_DETAILS = 'Bank transfer details: edit BANK_DETAILS in /var/www/wappflow/api/.env';
  assert.equal((await call('GET', '/api/app/billing')).data.bankDetails, null);
  process.env.BANK_DETAILS = 'Boubyan Bank · IBAN KW12 BBYN 0000 1234';
  assert.equal((await call('GET', '/api/app/billing')).data.bankDetails, 'Boubyan Bank · IBAN KW12 BBYN 0000 1234');
  delete process.env.BANK_DETAILS;
});
