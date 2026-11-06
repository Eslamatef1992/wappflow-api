// WhatsApp OTP: API send/verify, prepaid credits, buying packs, plan gating.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dbFile = path.join(os.tmpdir(), `wf-otp-${Date.now()}.sqlite`);
let server; let base; let owner; let admin; let key; let db; let tenantId;

before(async () => {
  Object.assign(process.env, { DB_FILE: dbFile, DB_CLIENT: '', MOCK_STATUS_DELAY_MS: '999999' });
  execFileSync('node', ['src/scripts/seed.js', '--demo'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });
  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await call('POST', '/api/auth/login', { email: 'owner@demo.local', password: 'demo12345' })).data.token;
  admin = (await call('POST', '/api/auth/login', { email: 'admin@wappflow.local', password: 'admin12345' })).data.token;
  key = (await call('POST', '/api/app/api-keys', { name: 'App' }, { Authorization: `Bearer ${owner}` })).data.key;
  tenantId = (await call('GET', '/api/auth/me', null, { Authorization: `Bearer ${owner}` })).data.tenant.id;
});
after(async () => { server.close(); await db.destroy(); fs.rmSync(dbFile, { force: true }); });

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const api = (m, u, b) => call(m, u, b, { 'X-Api-Key': key });
const app = (m, u, b) => call(m, u, b, { Authorization: `Bearer ${owner}` });
const adm = (m, u, b) => call(m, u, b, { Authorization: `Bearer ${admin}` });
const allowNextSend = () => db('otp_codes').update({ created_at: Date.now() - 31_000 }); // skip the 30 s cooldown in tests

test('OTP needs a template, then credits', async () => {
  let r = await api('POST', '/api/v1/otp/send', { phone: '+96550001111' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /No approved OTP template/);

  r = await app('POST', '/api/app/otp/setup/recommended', { language: 'en' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.template.name, 'otp_code');
  assert.equal(r.data.template.status, 'APPROVED');
  const tpl = await db('templates').where({ id: r.data.template.id }).first();
  assert.equal(tpl.category, 'AUTHENTICATION');

  r = await api('POST', '/api/v1/otp/send', { phone: '+96550001111' });
  assert.equal(r.status, 402);
  assert.match(r.data.error, /Not enough OTP credits/);
  assert.equal(await db('otp_codes').count({ c: '*' }).first().then((x) => +x.c), 0);
});

test('admin can give credits; balance via API', async () => {
  const r = await adm('POST', `/api/admin/tenants/${tenantId}/credits`, { credits: 10, note: 'welcome' });
  assert.equal(r.status, 200);
  assert.equal(r.data.credits, 10);
  assert.deepEqual((await api('GET', '/api/v1/otp/balance')).data, { credits: 10 });
});

test('send a code: 1 credit, WhatsApp auth template with copy-code button, code never stored in clear', async () => {
  const r = await api('POST', '/api/v1/otp/send', { phone: '+965 5000 1111', code: '482913', reference: 'user-42' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  assert.equal(r.data.credits_left, 9);
  assert.ok(r.data.expires_at > Date.now() + 9 * 60_000);
  const otp = await db('otp_codes').where({ id: r.data.id }).first();
  assert.notEqual(otp.code_hash, '482913');
  assert.ok(!JSON.stringify(otp).includes('482913'));
  const msg = await db('messages').where({ id: otp.message_id }).first();
  assert.equal(msg.type, 'template');
  assert.ok(!msg.content.includes('482913'), 'code not kept in the message history');
  assert.ok(!msg.body.includes('482913'), 'code not shown in the inbox');
  const ledger = await db('credit_ledger').where({ tenant_id: tenantId }).orderBy('id', 'desc').first();
  assert.deepEqual([ledger.delta, ledger.reason, ledger.balance_after], [-1, 'otp', 9]);
});

test('the message sent to WhatsApp carries the code in the body and the copy button', async () => {
  const { otpMessage } = await import('../src/services/otp.js');
  const tpl = await db('templates').where({ name: 'otp_code' }).first();
  const m = otpMessage(tpl, '1234');
  assert.deepEqual(m.template.components, [
    { type: 'body', parameters: [{ type: 'text', text: '1234' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '1234' }] },
  ]);
});

test('verify: wrong code, right code, then it cannot be reused', async () => {
  let r = await api('POST', '/api/v1/otp/verify', { phone: '+96550001111', code: '000000' });
  assert.deepEqual(r.data, { valid: false, reason: 'invalid_code', attempts_left: 4 });
  r = await api('POST', '/api/v1/otp/verify', { phone: '96550001111', code: '482913' });
  assert.equal(r.data.valid, true);
  assert.equal(r.data.reference, 'user-42');
  r = await api('POST', '/api/v1/otp/verify', { phone: '96550001111', code: '482913' });
  assert.deepEqual(r.data, { valid: false, reason: 'already_used' });
});

test('resend cooldown, expiry, and blocking after 5 wrong tries', async () => {
  await allowNextSend();
  let r = await api('POST', '/api/v1/otp/send', { phone: '+96550001111', code: '111111' });
  assert.equal(r.status, 201);
  r = await api('POST', '/api/v1/otp/send', { phone: '+96550001111' });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /wait/);

  await db('otp_codes').where({ status: 'pending' }).update({ expires_at: Date.now() - 1 });
  r = await api('POST', '/api/v1/otp/verify', { phone: '+96550001111', code: '111111' });
  assert.deepEqual(r.data, { valid: false, reason: 'expired' });

  await allowNextSend();
  await api('POST', '/api/v1/otp/send', { phone: '+96550001111', code: '222222' });
  for (let i = 0; i < 5; i++) r = await api('POST', '/api/v1/otp/verify', { phone: '+96550001111', code: '999999' });
  assert.equal(r.data.reason, 'too_many_attempts');
  r = await api('POST', '/api/v1/otp/verify', { phone: '+96550001111', code: '222222' });
  assert.deepEqual(r.data, { valid: false, reason: 'too_many_attempts' });
});

test('a new code replaces the previous one', async () => {
  await db('otp_codes').update({ created_at: Date.now() - 31_000 });
  await api('POST', '/api/v1/otp/send', { phone: '+96550002222', code: '333333' });
  await allowNextSend();
  await api('POST', '/api/v1/otp/send', { phone: '+96550002222', code: '444444' });
  assert.equal((await api('POST', '/api/v1/otp/verify', { phone: '+96550002222', code: '333333' })).data.reason, 'invalid_code');
  assert.equal((await api('POST', '/api/v1/otp/verify', { phone: '+96550002222', code: '444444' })).data.valid, true);
});

test('a failed send gives the credit back', async () => {
  const before = (await api('GET', '/api/v1/otp/balance')).data.credits;
  const r = await api('POST', '/api/v1/otp/send', { phone: '+96550000000' }); // the mock rejects numbers ending 0000
  assert.equal(r.status, 400);
  assert.equal((await api('GET', '/api/v1/otp/balance')).data.credits, before);
  assert.equal((await db('otp_codes').orderBy('id', 'desc').first()).status, 'failed');
});

test('buy a credit pack: invoice, paid by card, credits added; it never touches the plan', async () => {
  const page = (await app('GET', '/api/app/otp')).data;
  assert.equal(page.packs.length, 3);
  const pack = page.packs[0];
  assert.deepEqual([pack.credits, pack.price, pack.currency], [500, 10, 'KWD']);
  const before = page.credits;

  const inv = (await app('POST', '/api/app/otp/buy', { packId: pack.id })).data;
  assert.equal(inv.credits, 500);
  assert.equal(+inv.amount, 10);
  assert.equal(inv.plan_id, null);
  assert.equal((await app('GET', '/api/app/otp')).data.openInvoice.id, inv.id);

  // an overdue credit invoice never locks the workspace or blocks renewals
  await db('invoices').where({ id: inv.id }).update({ due_at: Date.now() - 1000 });
  const { runBillingCycle, markInvoicePaid } = await import('../src/services/billing.js');
  const statusBefore = (await db('tenants').where({ id: tenantId }).first()).status;
  await runBillingCycle();
  assert.equal((await db('tenants').where({ id: tenantId }).first()).status, statusBefore);

  await markInvoicePaid(inv.id, { provider: 'paypal', ref: 'CAP-OTP' });
  assert.equal((await app('GET', '/api/app/otp')).data.credits, before + 500);
  assert.equal((await db('tenants').where({ id: tenantId }).first()).status, statusBefore, 'plan status unchanged');
  const credits = (await app('GET', '/api/app/otp/credits')).data.data;
  assert.equal(credits[0].reason, 'purchase');
  assert.equal(credits[0].delta, 500);
});

test('choosing a plan does not cancel an open credit invoice', async () => {
  const page = (await app('GET', '/api/app/otp')).data;
  const inv = (await app('POST', '/api/app/otp/buy', { packId: page.packs[1].id })).data;
  const plans = (await app('GET', '/api/app/billing')).data.plans;
  await app('POST', '/api/app/billing/subscribe', { planId: plans[2].id });
  assert.equal((await db('invoices').where({ id: inv.id }).first()).status, 'unpaid');
});

test('dashboard activity masks phone numbers; test send works', async () => {
  await allowNextSend();
  const t = await app('POST', '/api/app/otp/test', { phone: '+96550003333' });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const act = (await app('GET', '/api/app/otp/activity')).data;
  assert.ok(act.total >= 5);
  assert.equal(act.data[0].phone, '+965•••••333');
  assert.equal(act.data[0].reference, 'dashboard test');
  assert.equal(act.data[0].code_hash, undefined);
});

test('admin manages packs', async () => {
  const made = await adm('POST', '/api/admin/otp-packs', { name: '100 codes', credits: 100, price: 2.5 });
  assert.equal(made.status, 201);
  assert.equal((await adm('PATCH', `/api/admin/otp-packs/${made.data.id}`, { price: 3 })).status, 200);
  assert.equal(+(await db('otp_packs').where({ id: made.data.id }).first()).price, 3);
  await adm('DELETE', `/api/admin/otp-packs/${made.data.id}`);
  assert.ok(!(await app('GET', '/api/app/otp')).data.packs.some((p) => p.id === made.data.id));
  assert.equal((await adm('POST', '/api/admin/otp-packs', { name: 'x', credits: 0, price: 1 })).status, 400);
});

test('OTP is part of Growth and Business, not Starter', async () => {
  const starter = await db('plans').where({ slug: 'starter' }).first();
  assert.equal(JSON.parse(starter.features).otp, false);
  assert.equal(JSON.parse((await db('plans').where({ slug: 'growth' }).first()).features).otp, true);
  const growth = (await db('tenants').where({ id: tenantId }).first()).plan_id;
  await db('tenants').where({ id: tenantId }).update({ plan_id: starter.id });
  await db('subscriptions').where({ tenant_id: tenantId }).update({ plan_id: starter.id });
  const r = await app('GET', '/api/app/otp');
  assert.equal(r.status, 402);
  assert.match(r.data.error, /otp is not included in your plan/);
  await db('tenants').where({ id: tenantId }).update({ plan_id: growth });
  await db('subscriptions').where({ tenant_id: tenantId }).update({ plan_id: growth });
});
