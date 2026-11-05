// End-to-end test against a fresh SQLite database using mock WhatsApp numbers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const dbFile = path.join(os.tmpdir(), `wappflow-test-${Date.now()}.sqlite`);
process.env.DB_FILE = dbFile;
process.env.MOCK_STATUS_DELAY_MS = '1';
process.env.SEND_RATE_PER_SEC = '50';
execFileSync('node', ['src/scripts/seed.js', '--demo'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });

const { createApp } = await import('../src/app.js');
const { drain } = await import('../src/lib/jobs.js');
const { db } = await import('../src/db.js');
await import('../src/whatsapp/inbound.js');
await import('../src/services/campaigns.js');
await import('../src/services/flows.js');

let server; let base; let owner; let admin;
const call = async (method, url, body, token, headers = {}) => {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
};
const settle = async () => { await new Promise((r) => setTimeout(r, 5)); await drain(); };

before(async () => {
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  owner = (await call('POST', '/api/auth/login', { email: 'owner@demo.local', password: 'demo12345' })).data.token;
  admin = (await call('POST', '/api/auth/login', { email: 'admin@wappflow.local', password: 'admin12345' })).data.token;
  assert.ok(owner && admin);
});
after(async () => { server.close(); await db.destroy(); fs.rmSync(dbFile, { force: true }); });

test('me returns workspace, plan and usage', async () => {
  const { data } = await call('GET', '/api/auth/me', undefined, owner);
  assert.equal(data.tenant.slug, 'demo-store');
  assert.equal(data.plan.slug, 'growth');
  assert.equal(data.usage.contacts, 6);
});

test('chatbot flow: keyword → buttons → question → answer', async () => {
  let r = await call('POST', '/api/app/simulate/inbound', { phone: '+96551112222', name: 'Khalid', text: 'Hi' }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const convId = r.data.conversation_id;
  let msgs = (await call('GET', `/api/app/conversations/${convId}/messages`, undefined, owner)).data;
  const menu = msgs.at(-1);
  assert.equal(menu.direction, 'out');
  assert.equal(menu.type, 'interactive');
  assert.match(menu.body, /Hi Khalid/);

  r = await call('POST', '/api/app/simulate/inbound', { phone: '+96551112222', replyId: 'menu::b2', text: 'Track my order' }, owner);
  r = await call('POST', '/api/app/simulate/inbound', { phone: '+96551112222', text: '1042' }, owner);
  msgs = (await call('GET', `/api/app/conversations/${convId}/messages`, undefined, owner)).data;
  assert.match(msgs.at(-1).body, /Order 1042 is being prepared/);
  const contact = (await call('GET', '/api/app/contacts?q=51112222', undefined, owner)).data.data[0];
  assert.equal(contact.attributes.last_order_no, '1042');

  // hand over to an agent
  await call('POST', '/api/app/simulate/inbound', { phone: '+96551112222', text: 'menu' }, owner);
  await call('POST', '/api/app/simulate/inbound', { phone: '+96551112222', replyId: 'menu::b3' }, owner);
  const conv = (await call('GET', `/api/app/conversations/${convId}`, undefined, owner)).data;
  assert.equal(conv.bot_active, false);
  assert.ok(conv.assigned_user_id);
  assert.ok(conv.contact.tags.some((t) => t.name === 'Needs agent'));
});

test('inbox: reply, note, 24h window enforcement, statuses', async () => {
  const list = (await call('GET', '/api/app/conversations?status=open', undefined, owner)).data;
  const conv = list.data[0];
  let r = await call('POST', `/api/app/conversations/${conv.id}/messages`, { type: 'text', text: 'Hello from the team' }, owner);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.status, 'sent');
  await settle();
  const msgs = (await call('GET', `/api/app/conversations/${conv.id}/messages`, undefined, owner)).data;
  assert.equal(msgs.find((m) => m.id === r.data.id).status, 'read');
  r = await call('POST', `/api/app/conversations/${conv.id}/notes`, { text: 'VIP customer' }, owner);
  assert.equal(r.status, 201);

  // contact who never wrote to us: free text is blocked, template allowed
  const start = await call('POST', '/api/app/conversations/start', { phone: '+96550010006' }, owner);
  r = await call('POST', `/api/app/conversations/${start.data.id}/messages`, { type: 'text', text: 'hey' }, owner);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /24-hour window/);
  const tpl = (await call('GET', '/api/app/templates', undefined, owner)).data.find((t) => t.name === 'order_shipped');
  r = await call('POST', `/api/app/conversations/${start.data.id}/messages`, { type: 'template', templateId: tpl.id, variables: { body: [{ source: 'field', value: 'contact.first_name' }, { source: 'static', value: '#77' }] } }, owner);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.body, 'Good news Mariam, order #77 is on its way 🚚');
});

test('campaign to a tag sends, tracks delivery and read', async () => {
  const tags = (await call('GET', '/api/app/tags', undefined, owner)).data;
  const vip = tags.find((t) => t.name === 'VIP');
  const tpl = (await call('GET', '/api/app/templates', undefined, owner)).data.find((t) => t.name === 'welcome_offer');
  const count = await call('POST', '/api/app/campaigns/audience-count', { audience: { tagIds: [vip.id] } }, owner);
  assert.equal(count.data.count, 2);
  let c = (await call('POST', '/api/app/campaigns', {
    name: 'VIP weekend', templateId: tpl.id, audience: { tagIds: [vip.id] },
    variables: { body: [{ source: 'field', value: 'contact.first_name' }, { source: 'static', value: '25%' }] },
  }, owner)).data;
  const r = await call('POST', `/api/app/campaigns/${c.id}/launch`, {}, owner);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  for (let i = 0; i < 40; i++) { // batches are throttled to ~1/second
    await settle();
    c = (await call('GET', `/api/app/campaigns/${c.id}`, undefined, owner)).data;
    if (c.status === 'completed' && c.read === 2) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(c.status, 'completed');
  assert.equal(c.sent, 2);
  assert.equal(c.delivered, 2);
  assert.equal(c.read, 2);
  const rec = (await call('GET', `/api/app/campaigns/${c.id}/recipients`, undefined, owner)).data;
  assert.equal(rec.total, 2);
});

test('public API + order automation + Shopify webhook', async () => {
  const key = (await call('POST', '/api/app/api-keys', { name: 'ERP' }, owner)).data.key;
  assert.match(key, /^wsk_/);
  let r = await call('POST', '/api/v1/orders', { id: 'A-1001', phone: '+965 5555 1234', name: 'Huda Saad', total: 19.5, items: [{ name: 'Rose Musk', quantity: 1 }] }, null, { 'X-API-Key': key });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const contact = (await call('GET', '/api/app/contacts?q=55551234', undefined, owner)).data.data[0];
  const conv = (await call('GET', '/api/app/conversations?status=all&q=55551234', undefined, owner)).data.data[0];
  const msgs = (await call('GET', `/api/app/conversations/${conv.id}/messages`, undefined, owner)).data;
  assert.equal(msgs[0].body, 'Thank you Huda! Your order A-1001 for 19.500 KWD is confirmed. We will message you when it ships.');
  assert.equal(contact.name, 'Huda Saad');

  r = await call('POST', '/api/v1/messages', { to: '+96555551234', template: 'order_shipped', variables: { body: ['Huda', 'A-1001'] } }, null, { 'X-API-Key': key });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await call('POST', '/api/v1/messages', { to: '+96555551234', text: 'hi' }, null, { 'X-API-Key': key });
  assert.equal(r.status, 400); // no inbound yet → window closed

  const integ = (await call('POST', '/api/app/integrations', { type: 'shopify', secret: 'shpss_test' }, owner)).data;
  const body = JSON.stringify({ id: 555, total_price: '12.000', currency: 'KWD', phone: '+96566667777', customer: { first_name: 'Reem', last_name: 'A' }, line_items: [{ title: 'Oud', quantity: 1, price: '12.000' }] });
  const sig = crypto.createHmac('sha256', 'shpss_test').update(body).digest('base64');
  const path_ = new URL(integ.webhook_url).pathname;
  r = await call('POST', path_, body, null, { 'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Topic': 'orders/create' });
  assert.equal(r.status, 200);
  r = await call('POST', path_, body, null, { 'X-Shopify-Hmac-Sha256': 'bad', 'X-Shopify-Topic': 'orders/create' });
  assert.equal(r.status, 401);
  const orders = (await call('GET', '/api/app/orders?source=shopify', undefined, owner)).data;
  assert.equal(orders.total, 1);
});

test('Meta webhook verify + inbound + status receipt', async () => {
  let r = await call('GET', '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wappflow-verify-token&hub.challenge=42');
  assert.equal(r.data, 42);
  const number = await db('wa_numbers').first();
  const payload = { object: 'whatsapp_business_account', entry: [{ id: 'x', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: number.phone_number_id },
    contacts: [{ wa_id: '96599990000', profile: { name: 'Webhook User' } }],
    messages: [{ from: '96599990000', id: 'wamid.TEST1', timestamp: '1700000000', type: 'text', text: { body: 'price?' } }],
  } }] }] };
  r = await call('POST', '/webhooks/whatsapp', payload);
  assert.equal(r.status, 200);
  await settle();
  const c = await db('contacts').where({ wa_id: '96599990000' }).first();
  assert.equal(c.name, 'Webhook User');
  // duplicate delivery is ignored
  await call('POST', '/webhooks/whatsapp', payload); await settle();
  assert.equal(+(await db('messages').where({ wamid: 'wamid.TEST1' }).count({ c: '*' }).first()).c, 1);
});

test('plan limits, billing and super-admin', async () => {
  // Growth allows 5 agents; demo has 2 users
  for (let i = 0; i < 3; i++) {
    const r = await call('POST', '/api/app/team', { name: `A${i}`, email: `a${i}@demo.local`, password: 'password1' }, owner);
    assert.equal(r.status, 201);
  }
  const over = await call('POST', '/api/app/team', { name: 'X', email: 'x@demo.local', password: 'password1' }, owner);
  assert.equal(over.status, 402);

  const billing = (await call('GET', '/api/app/billing', undefined, owner)).data;
  const business = billing.plans.find((p) => p.slug === 'business');
  const inv = (await call('POST', '/api/app/billing/subscribe', { planId: business.id }, owner)).data;
  assert.equal(inv.status, 'unpaid');
  assert.equal(+inv.amount, 79);

  const stats = (await call('GET', '/api/admin/stats', undefined, admin)).data;
  assert.equal(stats.tenants, 1);
  let r = await call('POST', `/api/admin/invoices/${inv.id}/mark-paid`, { reference: 'BANK-1' }, admin);
  assert.equal(r.data.status, 'paid');
  const me = (await call('GET', '/api/auth/me', undefined, owner)).data;
  assert.equal(me.tenant.status, 'active');
  assert.equal(me.plan.slug, 'business');
  assert.equal(me.subscription.status, 'active');

  // tenants cannot reach admin; suspended tenants are blocked except billing
  assert.equal((await call('GET', '/api/admin/stats', undefined, owner)).status, 403);
  await call('PATCH', `/api/admin/tenants/${me.tenant.id}`, { status: 'suspended' }, admin);
  assert.equal((await call('GET', '/api/app/contacts', undefined, owner)).status, 402);
  assert.equal((await call('GET', '/api/app/billing', undefined, owner)).status, 200);
  await call('PATCH', `/api/admin/tenants/${me.tenant.id}`, { status: 'active' }, admin);

  const imp = (await call('POST', `/api/admin/tenants/${me.tenant.id}/impersonate`, {}, admin)).data;
  assert.equal((await call('GET', '/api/auth/me', undefined, imp.token)).data.impersonatedBy > 0, true);
});

test('signup creates a trial workspace; analytics responds', async () => {
  const r = await call('POST', '/api/auth/signup', { company: 'Cafe Sahi', name: 'Ali', email: 'ali@sahi.test', password: 'password1' });
  assert.equal(r.status, 201);
  const me = (await call('GET', '/api/auth/me', undefined, r.data.token)).data;
  assert.equal(me.tenant.status, 'trial');
  assert.equal(me.subscription.status, 'trialing');
  const a = (await call('GET', '/api/app/analytics?days=30', undefined, owner)).data;
  assert.ok(a.kpis.messagesOut > 0);
  assert.equal(a.series.length, 30);
  // CSV import
  const fd = new FormData();
  fd.append('file', new Blob(['phone,name,city,tags\n+96560001111,Test One,Salmiya,Imported|VIP\n12,Bad,,\n'], { type: 'text/csv' }), 'c.csv');
  const imp = await fetch(`${base}/api/app/contacts/import`, { method: 'POST', headers: { Authorization: `Bearer ${owner}` }, body: fd }).then((x) => x.json());
  assert.equal(imp.created, 1);
  assert.equal(imp.skipped, 1);
});
