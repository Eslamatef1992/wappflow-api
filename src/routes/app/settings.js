import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../../config.js';
import { db, j, s, now, insert } from '../../db.js';
import { h, bad, notFound, required, encrypt, randomToken, sha256 } from '../../lib/util.js';
import { requireRole, publicUser } from '../../lib/auth.js';
import { assertLimit, assertFeature, assertPaid } from '../../services/billing.js';
import { clientFor, exchangeSignupCode, registerNumber, subscribeApp } from '../../whatsapp/client.js';

const r = Router();
const admins = requireRole('owner', 'admin');

// ---------- workspace ----------
r.patch('/workspace', admins, h(async (req, res) => {
  const patch = {};
  ['name', 'timezone', 'locale'].forEach((k) => { if (req.body[k]) patch[k] = req.body[k]; });
  if (req.body.settings) patch.settings = s({ ...j(req.tenant.settings, {}), ...req.body.settings });
  await db('tenants').where({ id: req.tenant.id }).update(patch);
  res.json(await db('tenants').where({ id: req.tenant.id }).first());
}));

// ---------- WhatsApp numbers ----------
const number = (n) => n && ({
  id: n.id, label: n.label, display_phone: n.display_phone, phone_number_id: n.phone_number_id, waba_id: n.waba_id,
  mode: n.mode, status: n.status, quality_rating: n.quality_rating, is_default: !!n.is_default, created_at: n.created_at,
});

r.get('/numbers', h(async (req, res) => {
  res.json({
    webhook: { url: `${config.apiUrl}/webhooks/whatsapp`, verifyToken: config.meta.verifyToken },
    data: (await db('wa_numbers').where({ tenant_id: req.tenant.id }).orderBy('id')).map(number),
  });
}));

async function makeDefaultIfFirst(tenantId, id) {
  const count = +(await db('wa_numbers').where({ tenant_id: tenantId }).count({ c: '*' }).first()).c;
  if (count === 1) await db('wa_numbers').where({ id }).update({ is_default: true });
}

/** Connect manually with a permanent System User token from Meta Business Manager, or add a demo number. */
r.post('/numbers', admins, h(async (req, res) => {
  if (req.body.mode !== 'mock') assertPaid(req.tenant, 'connect your WhatsApp number');
  await assertLimit(req.tenant, 'numbers', 1);
  if (req.body.mode === 'mock') {
    const pid = `mock-${req.tenant.id}-${randomToken(6)}`;
    const id = await insert('wa_numbers', {
      tenant_id: req.tenant.id, label: req.body.label || 'Demo number', display_phone: req.body.display_phone || '+965 5000 0000',
      phone_number_id: pid, waba_id: `mock-waba-${req.tenant.id}`, mode: 'mock', status: 'connected', quality_rating: 'GREEN', created_at: now(),
    });
    await makeDefaultIfFirst(req.tenant.id, id);
    return res.status(201).json(number(await db('wa_numbers').where({ id }).first()));
  }
  required(req.body, ['phone_number_id', 'waba_id', 'access_token']);
  if (await db('wa_numbers').where({ phone_number_id: req.body.phone_number_id }).first()) throw bad('This number is already connected to a workspace');
  const draft = { mode: 'live', phone_number_id: String(req.body.phone_number_id).trim(), waba_id: String(req.body.waba_id).trim(), access_token_enc: encrypt(String(req.body.access_token).trim()) };
  const info = await clientFor(draft).phoneInfo(); // verifies the token works
  await subscribeApp(String(req.body.access_token).trim(), draft.waba_id).catch(() => {}); // route webhooks of this WABA to our app
  const id = await insert('wa_numbers', {
    tenant_id: req.tenant.id, label: req.body.label || info.verified_name, display_phone: info.display_phone_number,
    ...draft, status: 'connected', quality_rating: info.quality_rating, created_at: now(),
  });
  await makeDefaultIfFirst(req.tenant.id, id);
  res.status(201).json(number(await db('wa_numbers').where({ id }).first()));
}));

/**
 * Meta Embedded Signup (when the platform is a Meta Tech Provider). The dashboard opens Meta's
 * popup with META_APP_ID + META_ES_CONFIG_ID, then posts { code, phone_number_id, waba_id } here.
 */
r.post('/numbers/embedded-signup', admins, h(async (req, res) => {
  assertPaid(req.tenant, 'connect your WhatsApp number');
  required(req.body, ['code', 'phone_number_id', 'waba_id']);
  if (!config.meta.appId || !config.meta.appSecret) throw bad('Embedded Signup is not configured on this server');
  await assertLimit(req.tenant, 'numbers', 1);
  const token = await exchangeSignupCode(req.body.code);
  await subscribeApp(token, req.body.waba_id);
  const pin = String(Math.floor(100000 + Math.random() * 900000));
  await registerNumber(token, req.body.phone_number_id, pin).catch(() => {}); // may already be registered
  const draft = { mode: 'live', phone_number_id: req.body.phone_number_id, waba_id: req.body.waba_id, access_token_enc: encrypt(token) };
  const info = await clientFor(draft).phoneInfo();
  const id = await insert('wa_numbers', {
    tenant_id: req.tenant.id, label: info.verified_name, display_phone: info.display_phone_number, ...draft,
    status: 'connected', quality_rating: info.quality_rating, created_at: now(),
  });
  await makeDefaultIfFirst(req.tenant.id, id);
  res.status(201).json(number(await db('wa_numbers').where({ id }).first()));
}));

r.post('/numbers/:id/refresh', admins, h(async (req, res) => {
  const n = await db('wa_numbers').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!n) throw notFound('Number');
  const info = await clientFor(n).phoneInfo();
  await db('wa_numbers').where({ id: n.id }).update({ display_phone: info.display_phone_number, quality_rating: info.quality_rating, status: 'connected' });
  res.json(number(await db('wa_numbers').where({ id: n.id }).first()));
}));

r.patch('/numbers/:id', admins, h(async (req, res) => {
  const n = await db('wa_numbers').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!n) throw notFound('Number');
  if (req.body.is_default) {
    await db('wa_numbers').where({ tenant_id: req.tenant.id }).update({ is_default: false });
    await db('wa_numbers').where({ id: n.id }).update({ is_default: true });
  }
  if (req.body.label) await db('wa_numbers').where({ id: n.id }).update({ label: req.body.label });
  if (req.body.access_token && n.mode === 'live') await db('wa_numbers').where({ id: n.id }).update({ access_token_enc: encrypt(req.body.access_token) });
  res.json(number(await db('wa_numbers').where({ id: n.id }).first()));
}));

r.delete('/numbers/:id', admins, h(async (req, res) => {
  await db('wa_numbers').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

// ---------- team ----------
r.get('/team', h(async (req, res) => {
  const users = await db('users').where({ tenant_id: req.tenant.id }).orderBy('id');
  const load = await db('conversations').where({ tenant_id: req.tenant.id, status: 'open' }).whereNotNull('assigned_user_id')
    .groupBy('assigned_user_id').select('assigned_user_id').count({ c: '*' });
  res.json(users.map((u) => ({ ...publicUser(u), open_conversations: +(load.find((l) => l.assigned_user_id === u.id)?.c || 0), online: !!u.last_seen_at && now() - u.last_seen_at < 5 * 60_000 })));
}));

r.post('/team', admins, h(async (req, res) => {
  required(req.body, ['name', 'email', 'password']);
  const email = String(req.body.email).toLowerCase().trim();
  if (await db('users').where({ email }).first()) throw bad('Email already in use');
  if (String(req.body.password).length < 8) throw bad('Password must be at least 8 characters');
  await assertLimit(req.tenant, 'agents', 1);
  const role = ['admin', 'agent'].includes(req.body.role) ? req.body.role : 'agent';
  const id = await insert('users', { tenant_id: req.tenant.id, name: req.body.name, email, role, is_active: true, password_hash: await bcrypt.hash(req.body.password, 10), created_at: now() });
  res.status(201).json(publicUser(await db('users').where({ id }).first()));
}));

r.patch('/team/:id', admins, h(async (req, res) => {
  const u = await db('users').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!u) throw notFound('User');
  if (u.role === 'owner' && req.user.role !== 'owner') throw bad('Only the owner can change the owner');
  const patch = {};
  if (req.body.name) patch.name = req.body.name;
  if (req.body.role && ['admin', 'agent'].includes(req.body.role) && u.role !== 'owner') patch.role = req.body.role;
  if (req.body.is_active !== undefined && u.id !== req.user.id) {
    if (req.body.is_active && !u.is_active) await assertLimit(req.tenant, 'agents', 1);
    patch.is_active = !!req.body.is_active;
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw bad('Password must be at least 8 characters');
    patch.password_hash = await bcrypt.hash(req.body.password, 10);
  }
  await db('users').where({ id: u.id }).update(patch);
  if (patch.is_active === false) await db('conversations').where({ assigned_user_id: u.id, status: 'open' }).update({ assigned_user_id: null });
  res.json(publicUser(await db('users').where({ id: u.id }).first()));
}));

r.delete('/team/:id', admins, h(async (req, res) => {
  const u = await db('users').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!u) throw notFound('User');
  if (u.role === 'owner' || u.id === req.user.id) throw bad('You cannot remove this user');
  await db('conversations').where({ assigned_user_id: u.id }).update({ assigned_user_id: null });
  await db('users').where({ id: u.id }).del();
  res.json({ ok: true });
}));

// ---------- developer: API keys & outgoing webhooks ----------
r.use(['/api-keys', '/webhooks'], h(async (req, _res, next) => { await assertFeature(req.tenant, 'api'); next(); }));

r.get('/api-keys', admins, h(async (req, res) => {
  res.json(await db('api_keys').where({ tenant_id: req.tenant.id }).select('id', 'name', 'prefix', 'last_used_at', 'created_at'));
}));
r.post('/api-keys', admins, h(async (req, res) => {
  const key = `wsk_${randomToken(24)}`;
  const id = await insert('api_keys', { tenant_id: req.tenant.id, name: req.body.name || 'API key', prefix: key.slice(0, 10), key_hash: sha256(key), created_at: now() });
  res.status(201).json({ id, name: req.body.name || 'API key', prefix: key.slice(0, 10), key }); // shown once
}));
r.delete('/api-keys/:id', admins, h(async (req, res) => {
  await db('api_keys').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

export const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'message.status', 'contact.created', 'conversation.updated', 'campaign.updated', 'order.created', 'order.paid', 'order.shipped', 'order.delivered', 'order.canceled'];
const endpoint = (e) => e && { ...e, events: j(e.events, ['*']), is_active: !!e.is_active };

r.get('/webhooks', admins, h(async (req, res) => {
  res.json({ events: WEBHOOK_EVENTS, data: (await db('webhook_endpoints').where({ tenant_id: req.tenant.id })).map(endpoint) });
}));
r.post('/webhooks', admins, h(async (req, res) => {
  required(req.body, ['url']);
  if (!/^https:\/\//.test(req.body.url) && config.env === 'production') throw bad('Webhook URL must use https');
  const id = await insert('webhook_endpoints', { tenant_id: req.tenant.id, url: req.body.url, events: s(req.body.events?.length ? req.body.events : ['*']), secret: `whsec_${randomToken(18)}`, is_active: true, created_at: now() });
  res.status(201).json(endpoint(await db('webhook_endpoints').where({ id }).first()));
}));
r.patch('/webhooks/:id', admins, h(async (req, res) => {
  const patch = {};
  if (req.body.url) patch.url = req.body.url;
  if (req.body.events) patch.events = s(req.body.events);
  if (req.body.is_active !== undefined) patch.is_active = !!req.body.is_active;
  await db('webhook_endpoints').where({ id: req.params.id, tenant_id: req.tenant.id }).update(patch);
  res.json(endpoint(await db('webhook_endpoints').where({ id: req.params.id }).first()));
}));
r.post('/webhooks/:id/test', admins, h(async (req, res) => {
  const ep = await db('webhook_endpoints').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!ep) throw notFound('Webhook');
  const { enqueue } = await import('../../lib/jobs.js');
  await enqueue('webhook.deliver', { endpointId: ep.id, event: 'webhook.test', data: { ok: true }, at: now() });
  res.json({ queued: true });
}));
r.delete('/webhooks/:id', admins, h(async (req, res) => {
  await db('webhook_endpoints').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

export default r;
