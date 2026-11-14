// Admin "Activate as paid": unlocks a preview or suspended workspace without an online payment.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dbFile = path.join(os.tmpdir(), `wf-act-${Date.now()}.sqlite`);
let server; let base; let owner; let admin; let db; let billing; let tenantId;

before(async () => {
  Object.assign(process.env, { DB_FILE: dbFile, DB_CLIENT: '' });
  delete process.env.GRACE_DAYS; delete process.env.TRIAL_DAYS;
  execFileSync('node', ['src/scripts/seed.js', '--demo'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });
  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  billing = await import('../src/services/billing.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  const login = async (email, password) => (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
  owner = await login('owner@demo.local', 'demo12345');
  admin = await login('admin@wappflow.local', 'admin12345');
  tenantId = (await call('GET', '/api/auth/me', null, owner)).data.tenant.id;
});
after(async () => { server.close(); await db.destroy(); fs.rmSync(dbFile, { force: true }); });

async function call(method, url, body, token = admin) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const tenant = () => db('tenants').where({ id: tenantId }).first();
const DAY = 86400_000;

test('activating a preview workspace as paid lets it go live right away', async () => {
  assert.equal((await call('GET', '/api/auth/me', null, owner)).data.preview, true);
  const plans = (await call('GET', '/api/admin/plans')).data;
  const growth = plans.find((p) => p.slug === 'growth');
  await call('POST', '/api/app/billing/subscribe', { planId: growth.id }, owner); // an open invoice gets replaced
  assert.equal((await call('POST', `/api/admin/tenants/${tenantId}/activate`, { planId: growth.id, interval: 'monthly' }, owner)).status, 403, 'owners cannot do this');

  const r = await call('POST', `/api/admin/tenants/${tenantId}/activate`, { planId: growth.id, interval: 'yearly', reference: 'KNET 5521' });
  assert.equal(r.status, 200);
  assert.equal(r.data.invoice.status, 'paid');
  assert.equal(+r.data.invoice.amount, 350);
  assert.equal(r.data.invoice.provider_ref, 'KNET 5521');
  const left = (r.data.subscription.current_period_end - Date.now()) / DAY;
  assert.ok(left > 364 && left < 367);
  assert.equal((await tenant()).status, 'active');
  assert.equal((await db('invoices').where({ tenant_id: tenantId, status: 'unpaid' })).length, 0, 'open invoices voided');
  assert.equal((await call('GET', '/api/auth/me', null, owner)).data.preview, false);
  await billing.runBillingCycle();
  assert.equal((await tenant()).status, 'active', 'the billing cycle keeps it active');
});

test('a suspended workspace can be activated for free until a chosen date', async () => {
  await db('subscriptions').where({ tenant_id: tenantId }).update({ current_period_end: Date.now() - 1000 });
  await billing.runBillingCycle();
  assert.equal((await tenant()).status, 'suspended');
  const plan = (await call('GET', '/api/admin/plans')).data[0];
  const until = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
  assert.equal((await call('POST', `/api/admin/tenants/${tenantId}/activate`, { planId: plan.id, until: '2020-01-01' })).status, 400);
  const r = await call('POST', `/api/admin/tenants/${tenantId}/activate`, { planId: plan.id, until, amount: 0 });
  assert.equal(r.status, 200);
  assert.equal(+r.data.invoice.amount, 0);
  assert.equal(new Date(r.data.subscription.current_period_end).toISOString().slice(0, 10), until);
  assert.equal((await tenant()).status, 'active');
  assert.equal((await call('GET', '/api/app/contacts', null, owner)).status, 200);
});

test('activating again while paid continues from the current end date', async () => {
  const before = (await db('subscriptions').where({ tenant_id: tenantId }).first()).current_period_end;
  const plan = (await call('GET', '/api/admin/plans')).data[0];
  const r = await call('POST', `/api/admin/tenants/${tenantId}/activate`, { planId: plan.id, interval: 'monthly', periods: 3 });
  const added = (r.data.subscription.current_period_end - before) / DAY;
  assert.ok(added >= 89 && added <= 93, `3 months added (${added})`);
  assert.equal(+r.data.invoice.amount, +plan.price_monthly * 3);
});
