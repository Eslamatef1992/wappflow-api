// Plan expiry: an unpaid renewal locks the workspace until it is paid (GRACE_DAYS=0 by default).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dbFile = path.join(os.tmpdir(), `wf-life-${Date.now()}.sqlite`);
let server; let base; let owner; let db; let billing; let tenantId;

before(async () => {
  Object.assign(process.env, { DB_FILE: dbFile, DB_CLIENT: '' });
  delete process.env.GRACE_DAYS;
  execFileSync('node', ['src/scripts/seed.js', '--demo'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });
  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  billing = await import('../src/services/billing.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@demo.local', password: 'demo12345' }) })).json()).token;
  tenantId = (await call('GET', '/api/auth/me')).data.tenant.id;
});
after(async () => { server.close(); await db.destroy(); fs.rmSync(dbFile, { force: true }); });

async function call(method, url, body) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${owner}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const tenant = () => db('tenants').where({ id: tenantId }).first();
const sub = () => db('subscriptions').where({ tenant_id: tenantId }).orderBy('id', 'desc').first();

test('choosing a plan during the trial never locks the workspace before the trial ends', async () => {
  const plans = (await call('GET', '/api/app/billing')).data.plans;
  const inv = (await call('POST', '/api/app/billing/subscribe', { planId: plans[0].id })).data;
  await db('invoices').where({ id: inv.id }).update({ due_at: Date.now() - 1000 }); // overdue, but the trial is still running
  await billing.runBillingCycle();
  assert.equal((await tenant()).status, 'trial');
  assert.equal((await call('GET', '/api/app/contacts')).status, 200);
});

test('when the trial / paid period ends unpaid, the workspace is locked at once except billing', async () => {
  await db('subscriptions').where({ id: (await sub()).id }).update({ current_period_end: Date.now() - 1000 });
  await billing.runBillingCycle();
  assert.equal((await tenant()).status, 'suspended');
  assert.equal((await sub()).status, 'past_due');
  const locked = await call('GET', '/api/app/contacts');
  assert.equal(locked.status, 402);
  assert.match(locked.data.error, /suspended/i);
  const b = await call('GET', '/api/app/billing');
  assert.equal(b.status, 200);
  assert.ok(b.data.invoices.some((i) => i.status === 'unpaid'));
});

test('paying unlocks the workspace and starts a new period', async () => {
  const unpaid = await db('invoices').where({ tenant_id: tenantId, status: 'unpaid' }).first();
  await billing.markInvoicePaid(unpaid.id, { provider: 'paypal', ref: 'CAP-1' });
  assert.equal((await tenant()).status, 'active');
  const s = await sub();
  assert.equal(s.status, 'active');
  assert.ok(s.current_period_end > Date.now() + 27 * 86400_000);
  assert.equal((await call('GET', '/api/app/contacts')).status, 200);
});

test('the next renewal locks again if not paid', async () => {
  await db('subscriptions').where({ id: (await sub()).id }).update({ current_period_end: Date.now() - 1000 });
  await billing.runBillingCycle();
  assert.equal((await tenant()).status, 'suspended');
  const invoices = await db('invoices').where({ tenant_id: tenantId, status: 'unpaid' });
  assert.equal(invoices.length, 1); // one renewal invoice, not duplicates
  await billing.runBillingCycle();
  assert.equal((await db('invoices').where({ tenant_id: tenantId, status: 'unpaid' })).length, 1);
});
