// Super-admin panel API: the platform owner manages tenants, plans, invoices and health.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, s, now, insert, period } from '../db.js';
import { config } from '../config.js';
import { h, bad, notFound, required, paginate, slugify } from '../lib/util.js';
import { requireAuth, requireSuperadmin, signToken, publicUser } from '../lib/auth.js';
import { queueEmail, mailEnabled, sendEmail, buildEmail } from '../services/email.js';
import { serializePlan, createInvoice, markInvoicePaid, startTrial, usageFor, LIMIT_KEYS, FEATURE_KEYS } from '../services/billing.js';

const r = Router();
r.use(requireAuth, requireSuperadmin);

const count = async (q) => +(await q.count({ c: '*' }).first()).c;

r.get('/stats', h(async (_req, res) => {
  const p = period();
  const mrrRows = await db('subscriptions as s').join('plans as p', 'p.id', 's.plan_id').where('s.status', 'active')
    .select('p.price_monthly', 'p.price_yearly', 's.billing_interval', 'p.currency');
  const mrr = mrrRows.reduce((a, x) => a + (x.billing_interval === 'yearly' ? +x.price_yearly / 12 : +x.price_monthly), 0);
  const usage = await db('usage_counters').where({ period: p }).sum({ sent: 'messages_sent', received: 'messages_received' }).first();
  const byStatus = await db('tenants').groupBy('status').select('status').count({ c: '*' });
  const revenue = await db('invoices').where({ status: 'paid' }).andWhere('paid_at', '>', now() - 365 * 86400000).select('amount', 'paid_at');
  const months = {};
  for (let i = 11; i >= 0; i--) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); months[d.toISOString().slice(0, 7)] = 0; }
  revenue.forEach((x) => { const k = new Date(+x.paid_at).toISOString().slice(0, 7); if (k in months) months[k] += +x.amount; });
  const signups = await db('tenants').where('created_at', '>', now() - 30 * 86400000).count({ c: '*' }).first();
  res.json({
    tenants: await count(db('tenants')),
    tenantsByStatus: Object.fromEntries(byStatus.map((x) => [x.status, +x.c])),
    signups30d: +signups.c,
    users: await count(db('users').whereNotNull('tenant_id')),
    numbers: await count(db('wa_numbers')),
    contacts: await count(db('contacts')),
    mrr: Math.round(mrr * 1000) / 1000,
    unpaidInvoices: await count(db('invoices').where({ status: 'unpaid' })),
    messagesThisMonth: { sent: +(usage?.sent || 0), received: +(usage?.received || 0) },
    revenueByMonth: Object.entries(months).map(([month, amount]) => ({ month, amount })),
    failedJobs: await count(db('jobs').where({ status: 'failed' })),
  });
}));

// ---------- tenants ----------
r.get('/tenants', h(async (req, res) => {
  const { limit, offset } = paginate(req);
  const q = db('tenants as t').leftJoin('plans as p', 'p.id', 't.plan_id');
  if (req.query.q) q.where((w) => w.where('t.name', 'like', `%${req.query.q}%`).orWhere('t.slug', 'like', `%${req.query.q}%`));
  if (req.query.status) q.where('t.status', req.query.status);
  const total = +(await q.clone().count({ c: 't.id' }).first()).c;
  const rows = await q.select('t.*', 'p.name as plan_name').orderBy('t.id', 'desc').limit(limit).offset(offset);
  const p = period();
  const usage = await db('usage_counters').where({ period: p }).whereIn('tenant_id', rows.map((x) => x.id));
  const owners = await db('users').whereIn('tenant_id', rows.map((x) => x.id)).where({ role: 'owner' }).select('tenant_id', 'email', 'name');
  res.json({
    total,
    data: rows.map((t) => ({
      ...t,
      messages_this_month: usage.find((u) => u.tenant_id === t.id)?.messages_sent || 0,
      owner: owners.find((o) => o.tenant_id === t.id) || null,
    })),
  });
}));

r.post('/tenants', h(async (req, res) => {
  required(req.body, ['company', 'name', 'email', 'password', 'planId']);
  const email = String(req.body.email).toLowerCase().trim();
  if (await db('users').where({ email }).first()) throw bad('Email already in use');
  let slug = slugify(req.body.company);
  if (await db('tenants').where({ slug }).first()) slug += `-${Date.now().toString(36)}`;
  const tenantId = await db.transaction(async (trx) => {
    const id = await insert('tenants', { name: req.body.company, slug, status: 'trial', plan_id: req.body.planId, created_at: now() }, trx);
    await startTrial(id, req.body.planId, trx);
    await insert('users', { tenant_id: id, name: req.body.name, email, role: 'owner', is_active: true, password_hash: await bcrypt.hash(req.body.password, 10), created_at: now() }, trx);
    return id;
  });
  await queueEmail('welcome', { tenantId });
  res.status(201).json(await db('tenants').where({ id: tenantId }).first());
}));

r.get('/tenants/:id', h(async (req, res) => {
  const t = await db('tenants').where({ id: req.params.id }).first();
  if (!t) throw notFound('Tenant');
  res.json({
    tenant: t,
    users: (await db('users').where({ tenant_id: t.id })).map(publicUser),
    numbers: await db('wa_numbers').where({ tenant_id: t.id }).select('id', 'label', 'display_phone', 'phone_number_id', 'mode', 'status', 'quality_rating'),
    subscription: await db('subscriptions').where({ tenant_id: t.id }).orderBy('id', 'desc').first(),
    invoices: await db('invoices').where({ tenant_id: t.id }).orderBy('id', 'desc').limit(24),
    usage: await usageFor(t.id),
  });
}));

r.patch('/tenants/:id', h(async (req, res) => {
  const t = await db('tenants').where({ id: req.params.id }).first();
  if (!t) throw notFound('Tenant');
  const patch = {};
  if (req.body.name) patch.name = req.body.name;
  if (req.body.status && ['trial', 'active', 'past_due', 'suspended'].includes(req.body.status)) patch.status = req.body.status;
  if (req.body.planId) {
    patch.plan_id = +req.body.planId;
    const sub = await db('subscriptions').where({ tenant_id: t.id }).orderBy('id', 'desc').first();
    if (sub) await db('subscriptions').where({ id: sub.id }).update({ plan_id: +req.body.planId });
  }
  if (req.body.extendDays) {
    const sub = await db('subscriptions').where({ tenant_id: t.id }).orderBy('id', 'desc').first();
    if (sub) {
      await db('subscriptions').where({ id: sub.id }).update({
        current_period_end: Math.max(sub.current_period_end || 0, now()) + +req.body.extendDays * 86400000,
        status: sub.status === 'past_due' ? 'active' : sub.status,
      });
      if (['past_due', 'suspended'].includes(t.status)) patch.status = sub.status === 'trialing' ? 'trial' : 'active';
    }
  }
  if (Object.keys(patch).length) await db('tenants').where({ id: t.id }).update(patch);
  await insert('audit_logs', { user_id: req.user.id, tenant_id: t.id, action: 'tenant.update', meta: s(req.body), created_at: now() });
  res.json(await db('tenants').where({ id: t.id }).first());
}));

r.delete('/tenants/:id', h(async (req, res) => {
  const t = await db('tenants').where({ id: req.params.id }).first();
  if (!t) throw notFound('Tenant');
  if (req.body?.confirm !== t.slug) throw bad(`Type the workspace slug "${t.slug}" to confirm`);
  // delete everything that belongs to the workspace explicitly (children first), so it works the same on every database
  await db.transaction(async (trx) => {
    const tid = t.id;
    const ids = (table) => trx(table).where({ tenant_id: tid }).select('id');
    await trx('messages').where({ tenant_id: tid }).del();
    await trx('conversations').where({ tenant_id: tid }).del();
    await trx('campaign_recipients').whereIn('campaign_id', ids('campaigns')).del();
    await trx('contact_tags').whereIn('contact_id', ids('contacts')).del();
    for (const table of ['campaigns', 'sales_invoices', 'orders', 'automations', 'integrations', 'products', 'flows', 'templates',
      'quick_replies', 'tags', 'contacts', 'api_keys', 'webhook_endpoints', 'wa_numbers', 'usage_counters', 'invoices', 'subscriptions', 'users']) {
      if (await trx.schema.hasTable(table)) await trx(table).where({ tenant_id: tid }).del();
    }
    await trx('tenants').where({ id: tid }).del();
  });
  await insert('audit_logs', { user_id: req.user.id, tenant_id: null, action: 'tenant.delete', meta: s({ id: t.id, name: t.name, slug: t.slug }), created_at: now() });
  res.json({ ok: true });
}));

/** Log in as the workspace owner to support them (token valid 2h, marked as impersonated). */
r.post('/tenants/:id/impersonate', h(async (req, res) => {
  const owner = await db('users').where({ tenant_id: req.params.id }).orderByRaw("case when role = 'owner' then 0 else 1 end").first();
  if (!owner) throw notFound('Workspace user');
  await insert('audit_logs', { user_id: req.user.id, tenant_id: owner.tenant_id, action: 'tenant.impersonate', created_at: now() });
  res.json({ token: signToken(owner, { imp: req.user.id }), user: publicUser(owner) });
}));

// ---------- plans ----------
function planPayload(b) {
  const limits = {};
  LIMIT_KEYS.forEach((k) => { if (b.limits?.[k] !== undefined && b.limits[k] !== '') limits[k] = +b.limits[k]; });
  const features = {};
  FEATURE_KEYS.forEach((k) => { features[k] = b.features?.[k] !== false; });
  return {
    name: b.name, slug: b.slug ? slugify(b.slug) : slugify(b.name), description: b.description || null, description_ar: b.description_ar || null,
    price_monthly: +b.price_monthly || 0, price_yearly: +b.price_yearly || 0, currency: (b.currency || 'KWD').toUpperCase(),
    limits: s(limits), features: s(features), is_active: b.is_active !== false, sort: +b.sort || 0,
  };
}

r.get('/plans', h(async (_req, res) => {
  const plans = await db('plans').orderBy('sort');
  const counts = await db('tenants').groupBy('plan_id').select('plan_id').count({ c: '*' });
  res.json(plans.map((p) => ({ ...serializePlan(p), tenants: +(counts.find((c) => c.plan_id === p.id)?.c || 0) })));
}));
r.post('/plans', h(async (req, res) => {
  required(req.body, ['name']);
  const id = await insert('plans', { ...planPayload(req.body), created_at: now() });
  res.status(201).json(serializePlan(await db('plans').where({ id }).first()));
}));
r.put('/plans/:id', h(async (req, res) => {
  required(req.body, ['name']);
  await db('plans').where({ id: req.params.id }).update(planPayload(req.body));
  res.json(serializePlan(await db('plans').where({ id: req.params.id }).first()));
}));
r.delete('/plans/:id', h(async (req, res) => {
  const used = await db('tenants').where({ plan_id: req.params.id }).first();
  if (used) throw bad('Plan is in use. Deactivate it instead.');
  await db('plans').where({ id: req.params.id }).del();
  res.json({ ok: true });
}));

// ---------- invoices ----------
r.get('/invoices', h(async (req, res) => {
  const { limit, offset } = paginate(req);
  const q = db('invoices as i').join('tenants as t', 't.id', 'i.tenant_id');
  if (req.query.status) q.where('i.status', req.query.status);
  const total = +(await q.clone().count({ c: 'i.id' }).first()).c;
  res.json({ total, data: await q.select('i.*', 't.name as tenant_name').orderBy('i.id', 'desc').limit(limit).offset(offset) });
}));
r.post('/invoices', h(async (req, res) => {
  required(req.body, ['tenantId', 'planId']);
  res.status(201).json(await createInvoice({ tenantId: +req.body.tenantId, planId: +req.body.planId, interval: req.body.interval || 'monthly', notes: req.body.notes }));
}));
r.post('/invoices/:id/mark-paid', h(async (req, res) => {
  res.json(await markInvoicePaid(+req.params.id, { provider: 'manual', ref: req.body?.reference || null }));
}));
r.post('/invoices/:id/void', h(async (req, res) => {
  await db('invoices').where({ id: req.params.id, status: 'unpaid' }).update({ status: 'void' });
  res.json(await db('invoices').where({ id: req.params.id }).first());
}));

// ---------- platform ----------
r.get('/jobs', h(async (_req, res) => {
  const byStatus = await db('jobs').groupBy('status').select('status').count({ c: '*' });
  const failed = await db('jobs').where({ status: 'failed' }).orderBy('id', 'desc').limit(30);
  res.json({ byStatus: Object.fromEntries(byStatus.map((x) => [x.status, +x.c])), failed });
}));
// ---------- account emails (Mailgun) ----------
r.get('/email', h(async (_req, res) => {
  res.json({ enabled: mailEnabled(), from: mailEnabled() ? config.mailgun.from : null });
}));
/** Send a sample of each account email to check Mailgun: { to, kind: welcome|invoice|receipt } */
r.post('/email/test', h(async (req, res) => {
  if (!mailEnabled()) throw bad('Email is not set up. Add MAILGUN_API_KEY and MAILGUN_DOMAIN to the server settings.');
  const to = String(req.body?.to || req.user.email).trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw bad('Enter a valid email address');
  const kind = ['welcome', 'invoice', 'receipt'].includes(req.body?.kind) ? req.body.kind : 'welcome';
  const t = now();
  const sample = {
    tenant: { name: 'Sample Store' }, owner: { name: req.user.name || 'there', email: to },
    plan: { name: 'Growth' }, sub: { current_period_end: t + 30 * 86400000 },
    invoice: { number: 'INV-SAMPLE', amount: 35, currency: 'KWD', notes: 'Growth plan (monthly)', due_at: t + 3 * 86400000, paid_at: t, provider: 'paypal' },
  };
  const mail = buildEmail(kind, sample);
  const out = await sendEmail({ to, ...mail, subject: `[Test] ${mail.subject}` });
  res.json({ ok: true, id: out.id || null });
}));

r.post('/jobs/:id/retry', h(async (req, res) => {
  await db('jobs').where({ id: req.params.id }).update({ status: 'pending', attempts: 0, run_at: now() });
  res.json({ ok: true });
}));

r.get('/audit', h(async (_req, res) => {
  res.json(await db('audit_logs as a').leftJoin('users as u', 'u.id', 'a.user_id').leftJoin('tenants as t', 't.id', 'a.tenant_id')
    .select('a.*', 'u.email as user_email', 't.name as tenant_name').orderBy('a.id', 'desc').limit(100));
}));

export default r;
