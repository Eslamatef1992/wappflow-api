// Plans, limits, subscriptions, invoices and online payment (Tap Payments: KNET, cards, Apple Pay).
import { config } from '../config.js';
import { db, j, s, now, insert, period } from '../db.js';
import { HttpError, bad } from '../lib/util.js';
import { registerJob, enqueue } from '../lib/jobs.js';
import { emitAdmin } from '../lib/events.js';

const DAY = 86_400_000;
export const LIMIT_KEYS = ['contacts', 'monthly_messages', 'agents', 'numbers', 'flows'];
export const FEATURE_KEYS = ['campaigns', 'inbox', 'flows', 'commerce', 'api'];

export async function planFor(tenant) {
  const plan = tenant.plan_id ? await db('plans').where({ id: tenant.plan_id }).first() : null;
  return plan ? { ...plan, limits: j(plan.limits, {}), features: j(plan.features, {}) } : { limits: {}, features: {} };
}

export async function usageFor(tenantId) {
  const p = period();
  const row = (await db('usage_counters').where({ tenant_id: tenantId, period: p }).first()) || {};
  const count = async (table, where = {}) => +(await db(table).where({ tenant_id: tenantId, ...where }).count({ c: '*' }).first()).c;
  return {
    period: p,
    contacts: await count('contacts'),
    agents: await count('users', { is_active: true }),
    numbers: await count('wa_numbers'),
    flows: await count('flows', { is_active: true }),
    monthly_messages: row.messages_sent || 0,
    messages_received: row.messages_received || 0,
    templates_sent: row.templates_sent || 0,
  };
}

const LABELS = {
  contacts: 'contacts', monthly_messages: 'messages this month', agents: 'team members', numbers: 'WhatsApp numbers', flows: 'active chatbot flows',
};

/** Throws 402 when adding `adding` more of `kind` would pass the plan limit. -1 or missing = unlimited. */
export async function assertLimit(tenant, kind, adding = 1) {
  const plan = await planFor(tenant);
  const limit = plan.limits?.[kind];
  if (limit === undefined || limit === null || +limit < 0) return;
  const usage = await usageFor(tenant.id);
  if (usage[kind] + adding > +limit) {
    throw new HttpError(402, `Your ${plan.name || 'current'} plan allows ${limit} ${LABELS[kind]}. Upgrade your plan to add more.`);
  }
}

export async function assertFeature(tenant, feature) {
  const plan = await planFor(tenant);
  if (plan.features && plan.features[feature] === false) {
    throw new HttpError(402, `${feature} is not included in your plan. Upgrade to unlock it.`);
  }
}

export async function addUsage(tenantId, field, n = 1) {
  const p = period();
  const updated = await db('usage_counters').where({ tenant_id: tenantId, period: p }).increment(field, n);
  if (!updated) {
    try {
      await db('usage_counters').insert({ tenant_id: tenantId, period: p, [field]: n });
    } catch {
      await db('usage_counters').where({ tenant_id: tenantId, period: p }).increment(field, n);
    }
  }
}

const addInterval = (ts, interval) => {
  const d = new Date(ts);
  if (interval === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
};

export async function startTrial(tenantId, planId, trx = db) {
  const t = now();
  const end = t + config.trialDays * DAY;
  await trx('tenants').where({ id: tenantId }).update({ status: 'trial', plan_id: planId, trial_ends_at: end });
  await insert('subscriptions', {
    tenant_id: tenantId, plan_id: planId, status: 'trialing', billing_interval: 'monthly',
    current_period_start: t, current_period_end: end, created_at: t,
  }, trx);
}

async function nextInvoiceNumber() {
  const y = new Date().getUTCFullYear();
  const c = +(await db('invoices').count({ c: '*' }).first()).c + 1;
  return `INV-${y}-${String(c).padStart(5, '0')}`;
}

export async function createInvoice({ tenantId, planId, interval = 'monthly', notes, periodStart, dueInDays = config.graceDays }) {
  const plan = await db('plans').where({ id: planId }).first();
  if (!plan) throw bad('Plan not found');
  const sub = await db('subscriptions').where({ tenant_id: tenantId }).orderBy('id', 'desc').first();
  const start = periodStart || now();
  const amount = interval === 'yearly' ? +plan.price_yearly || +plan.price_monthly * 12 : +plan.price_monthly;
  const id = await insert('invoices', {
    number: await nextInvoiceNumber(),
    tenant_id: tenantId, subscription_id: sub?.id || null, plan_id: planId,
    amount, currency: plan.currency, status: amount > 0 ? 'unpaid' : 'paid',
    notes: notes || `${plan.name} plan (${interval})`,
    period_start: start, period_end: addInterval(start, interval),
    due_at: now() + dueInDays * DAY, created_at: now(), paid_at: amount > 0 ? null : now(),
  });
  const invoice = await db('invoices').where({ id }).first();
  if (amount <= 0) await applyPaidInvoice(invoice, interval);
  return invoice;
}

/** Called after payment (manual or online). Activates/extends the subscription. */
export async function applyPaidInvoice(invoice, interval) {
  const sub = await db('subscriptions').where({ tenant_id: invoice.tenant_id }).orderBy('id', 'desc').first();
  const iv = interval || sub?.billing_interval || 'monthly';
  const start = Math.max(now(), sub?.status === 'active' ? sub.current_period_end || 0 : 0);
  const end = addInterval(start, iv);
  if (sub) {
    await db('subscriptions').where({ id: sub.id }).update({
      plan_id: invoice.plan_id || sub.plan_id, status: 'active', billing_interval: iv, current_period_start: start, current_period_end: end,
    });
  } else {
    await insert('subscriptions', {
      tenant_id: invoice.tenant_id, plan_id: invoice.plan_id, status: 'active', billing_interval: iv,
      current_period_start: start, current_period_end: end, created_at: now(),
    });
  }
  await db('tenants').where({ id: invoice.tenant_id }).update({ status: 'active', plan_id: invoice.plan_id || undefined });
}

export async function markInvoicePaid(invoiceId, { provider = 'manual', ref = null } = {}) {
  const inv = await db('invoices').where({ id: invoiceId }).first();
  if (!inv) throw bad('Invoice not found');
  if (inv.status === 'paid') return inv;
  await db('invoices').where({ id: inv.id }).update({ status: 'paid', paid_at: now(), provider, provider_ref: ref });
  const sub = await db('subscriptions').where({ tenant_id: inv.tenant_id }).orderBy('id', 'desc').first();
  await applyPaidInvoice({ ...inv, status: 'paid' }, sub?.billing_interval);
  emitAdmin('invoice.paid', { id: inv.id, tenant_id: inv.tenant_id });
  return db('invoices').where({ id: inv.id }).first();
}

// ---------------- Tap Payments (KNET / cards / Apple Pay) ----------------
// Verify field names against Tap's current docs in sandbox before going live.
export const tapEnabled = () => !!config.tap.secretKey;

export async function createTapCharge(invoice, tenant, user) {
  if (!tapEnabled()) throw bad('Online payment is not configured. Please pay by bank transfer.');
  const [first, ...rest] = (user.name || 'Customer').split(' ');
  const res = await fetch(`${config.tap.apiBase}/charges`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.tap.secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: +invoice.amount,
      currency: invoice.currency,
      threeDSecure: true,
      description: `${config.brand} ${invoice.number}`,
      metadata: { invoice_id: String(invoice.id), tenant_id: String(tenant.id) },
      reference: { transaction: invoice.number, order: invoice.number },
      customer: { first_name: first, last_name: rest.join(' ') || '-', email: user.email },
      source: { id: 'src_all' },
      post: { url: `${config.apiUrl}/api/billing/tap/webhook` },
      redirect: { url: `${config.apiUrl}/api/billing/tap/return?invoice=${invoice.id}` },
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.transaction?.url) throw bad(data.errors?.[0]?.description || 'Could not start payment');
  await db('invoices').where({ id: invoice.id }).update({ provider: 'tap', provider_ref: data.id });
  return data.transaction.url;
}

/** Never trust the webhook body: re-fetch the charge from Tap and check it. */
export async function confirmTapCharge(chargeId) {
  if (!tapEnabled() || !chargeId) return null;
  const res = await fetch(`${config.tap.apiBase}/charges/${encodeURIComponent(chargeId)}`, {
    headers: { Authorization: `Bearer ${config.tap.secretKey}` },
  });
  const charge = await res.json();
  const invoiceId = +charge?.metadata?.invoice_id;
  if (charge?.status === 'CAPTURED' && invoiceId) {
    const inv = await db('invoices').where({ id: invoiceId }).first();
    if (inv && +inv.amount === +charge.amount) return markInvoicePaid(inv.id, { provider: 'tap', ref: charge.id });
  }
  return null;
}

// ---------------- Lifecycle job ----------------
/** Renewals and lock-outs. Runs every few minutes as the billing.cycle job. */
export async function runBillingCycle() {
  const t = now();
  // 1) periods that ended → issue renewal invoice and move to past_due
  const due = await db('subscriptions').whereIn('status', ['trialing', 'active']).andWhere('current_period_end', '<', t);
  for (const sub of due) {
    const open = await db('invoices').where({ tenant_id: sub.tenant_id, status: 'unpaid' }).first();
    if (!open) await createInvoice({ tenantId: sub.tenant_id, planId: sub.plan_id, interval: sub.billing_interval, periodStart: sub.current_period_end });
    const fresh = await db('subscriptions').where({ id: sub.id }).first();
    if (fresh.current_period_end < t) {
      await db('subscriptions').where({ id: sub.id }).update({ status: 'past_due' });
      // no grace period (GRACE_DAYS=0, the default): the workspace is locked until the renewal is paid
      await db('tenants').where({ id: sub.tenant_id }).whereNot('status', 'suspended').update({ status: config.graceDays > 0 ? 'past_due' : 'suspended' });
    }
  }
  // 2) unpaid invoices past their due date → suspend the workspace
  //    (only when the paid/trial period is also over: picking a new plan mid-period never locks anyone out early)
  const overdue = await db('invoices').where({ status: 'unpaid' }).andWhere('due_at', '<', t).select('tenant_id');
  const ids = [];
  for (const tid of new Set(overdue.map((o) => o.tenant_id))) {
    const sub = await db('subscriptions').where({ tenant_id: tid }).orderBy('id', 'desc').first();
    if (!sub || !sub.current_period_end || sub.current_period_end < t || sub.status === 'past_due') ids.push(tid);
  }
  if (ids.length) await db('tenants').whereIn('id', ids).whereNot('status', 'suspended').update({ status: 'suspended' });
}

registerJob('billing.cycle', async () => {
  await runBillingCycle();
  return { retryInMs: 5 * 60_000 }; // every 5 minutes, so an expired plan locks promptly
});

export async function ensureBillingJob() {
  const exists = await db('jobs').where({ type: 'billing.cycle' }).whereIn('status', ['pending', 'running']).first();
  if (!exists) await enqueue('billing.cycle', {}, { delayMs: 5000 });
}

export function serializePlan(p) {
  return p && { ...p, price_monthly: +p.price_monthly, price_yearly: +p.price_yearly, limits: j(p.limits, {}), features: j(p.features, {}), is_active: !!p.is_active };
}

export { s };
