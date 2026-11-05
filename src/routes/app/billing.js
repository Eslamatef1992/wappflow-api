import { Router } from 'express';
import { db, now } from '../../db.js';
import { h, bad, notFound, required } from '../../lib/util.js';
import { requireRole } from '../../lib/auth.js';
import { planFor, usageFor, serializePlan, createInvoice, createTapCharge, tapEnabled } from '../../services/billing.js';

const r = Router();

r.get('/billing', h(async (req, res) => {
  const plan = await planFor(req.tenant);
  res.json({
    tenant: { id: req.tenant.id, name: req.tenant.name, status: req.tenant.status, trial_ends_at: req.tenant.trial_ends_at },
    plan: plan.id ? serializePlan(plan) : null,
    subscription: await db('subscriptions').where({ tenant_id: req.tenant.id }).orderBy('id', 'desc').first() || null,
    usage: await usageFor(req.tenant.id),
    invoices: await db('invoices').where({ tenant_id: req.tenant.id }).orderBy('id', 'desc').limit(36),
    plans: (await db('plans').where({ is_active: true }).orderBy('sort')).map(serializePlan),
    onlinePayments: tapEnabled(),
    bankDetails: process.env.BANK_DETAILS || null,
  });
}));

/** Choose a plan → creates an invoice (activates immediately once paid). */
r.post('/billing/subscribe', requireRole('owner', 'admin'), h(async (req, res) => {
  required(req.body, ['planId']);
  const plan = await db('plans').where({ id: req.body.planId, is_active: true }).first();
  if (!plan) throw notFound('Plan');
  const interval = req.body.interval === 'yearly' ? 'yearly' : 'monthly';
  await db('invoices').where({ tenant_id: req.tenant.id, status: 'unpaid' }).update({ status: 'void', notes: 'Replaced by a new plan selection' });
  const sub = await db('subscriptions').where({ tenant_id: req.tenant.id }).orderBy('id', 'desc').first();
  if (sub) await db('subscriptions').where({ id: sub.id }).update({ billing_interval: interval });
  const invoice = await createInvoice({ tenantId: req.tenant.id, planId: plan.id, interval, dueInDays: 3 });
  res.status(201).json(invoice);
}));

r.post('/billing/invoices/:id/pay', requireRole('owner', 'admin'), h(async (req, res) => {
  const inv = await db('invoices').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'unpaid') throw bad(`Invoice is ${inv.status}`);
  res.json({ url: await createTapCharge(inv, req.tenant, req.user) });
}));

r.post('/billing/cancel', requireRole('owner'), h(async (req, res) => {
  const sub = await db('subscriptions').where({ tenant_id: req.tenant.id }).orderBy('id', 'desc').first();
  if (!sub) throw notFound('Subscription');
  // stays active until the end of the paid period; no renewal invoice afterwards
  await db('subscriptions').where({ id: sub.id }).update({ status: 'canceled', canceled_at: now() });
  res.json({ ok: true, active_until: sub.current_period_end });
}));

export default r;
