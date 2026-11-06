// Dashboard: WhatsApp OTP — credits, buying packs, the OTP template, test sends and activity.
import { Router } from 'express';
import { db, j, s, now, insert } from '../../db.js';
import { h, bad, notFound, paginate } from '../../lib/util.js';
import { assertFeature, createCreditInvoice } from '../../services/billing.js';
import { getNumber } from '../../services/messaging.js';
import { clientFor } from '../../whatsapp/client.js';
import { OTP_EVENT, otpTemplate, sendOtp, creditBalance, serializeOtp } from '../../services/otp.js';

const r = Router();
const admins = h(async (req, _res, next) => { if (!['owner', 'admin'].includes(req.user.role)) throw bad('Only owners and admins can do this'); next(); });
r.use('/otp', h(async (req, _res, next) => { await assertFeature(req.tenant, 'otp'); next(); }));

const packOut = (p) => ({ id: p.id, name: p.name, name_ar: p.name_ar, credits: p.credits, price: +p.price, currency: p.currency });

r.get('/otp', h(async (req, res) => {
  const tid = req.tenant.id;
  const since = now() - 30 * 86400_000;
  const byStatus = await db('otp_codes').where({ tenant_id: tid }).andWhere('created_at', '>', since).groupBy('status').select('status').count({ c: '*' });
  const stats = Object.fromEntries(byStatus.map((x) => [x.status, +x.c]));
  const setup = await db('automations as a').leftJoin('templates as t', 't.id', 'a.template_id').where({ 'a.tenant_id': tid, 'a.event': OTP_EVENT })
    .first('a.template_id', 'a.wa_number_id', 't.name as template_name', 't.language as template_language', 't.status as template_status');
  const templates = await db('templates').where({ tenant_id: tid, category: 'AUTHENTICATION' }).select('id', 'name', 'language', 'status');
  res.json({
    credits: await creditBalance(tid),
    stats: { sent: Object.values(stats).reduce((a, b) => a + b, 0), verified: stats.verified || 0, failed: stats.failed || 0 },
    setup: setup || null,
    templates,
    packs: (await db('otp_packs').where({ is_active: true }).orderBy(['sort', 'credits'])).map(packOut),
    openInvoice: await db('invoices').where({ tenant_id: tid, status: 'unpaid' }).whereNotNull('credits').first('id', 'number', 'amount', 'currency', 'credits'),
  });
}));

r.get('/otp/activity', h(async (req, res) => {
  const { limit, offset } = paginate(req);
  const q = db('otp_codes').where({ tenant_id: req.tenant.id });
  if (req.query.status) q.where({ status: req.query.status });
  const total = +(await q.clone().count({ c: '*' }).first()).c;
  res.json({ total, data: (await q.orderBy('id', 'desc').limit(limit).offset(offset)).map(serializeOtp) });
}));

r.get('/otp/credits', h(async (req, res) => {
  const rows = await db('credit_ledger').where({ tenant_id: req.tenant.id }).whereNot('reason', 'otp').orderBy('id', 'desc').limit(50);
  res.json({ data: rows });
}));

/** Buy a credit pack: creates the invoice; the dashboard then sends the customer to the card payment page. */
r.post('/otp/buy', admins, h(async (req, res) => {
  const inv = await createCreditInvoice({ tenantId: req.tenant.id, packId: req.body?.packId });
  res.status(201).json(inv);
}));

/** Choose which approved template carries the codes. */
r.put('/otp/setup', admins, h(async (req, res) => {
  const t = await db('templates').where({ id: req.body?.templateId, tenant_id: req.tenant.id }).first();
  if (!t) throw notFound('Template');
  const row = { template_id: t.id, variables: s({}), is_active: true, wa_number_id: req.body.numberId || null };
  const existing = await db('automations').where({ tenant_id: req.tenant.id, event: OTP_EVENT }).first();
  if (existing) await db('automations').where({ id: existing.id }).update(row);
  else await insert('automations', { tenant_id: req.tenant.id, event: OTP_EVENT, ...row });
  res.json({ ok: true });
}));

/** One click: submit Meta's authentication template ("123456 is your verification code" + Copy code) and use it. */
r.post('/otp/setup/recommended', admins, h(async (req, res) => {
  const tpl = otpTemplate(req.body?.language === 'ar' ? 'ar' : 'en', 10);
  let t = await db('templates').where({ tenant_id: req.tenant.id, name: tpl.name, language: tpl.language }).first();
  if (!t) {
    const number = await getNumber(req.tenant.id, req.body?.numberId);
    const result = await clientFor(number).createTemplate({ name: tpl.name, language: tpl.language, category: tpl.category, components: tpl.meta });
    const id = await insert('templates', {
      tenant_id: req.tenant.id, wa_number_id: number.id, meta_id: result.id, name: tpl.name, language: tpl.language,
      category: 'AUTHENTICATION', status: result.status || 'PENDING', components: s(tpl.stored), created_at: now(), updated_at: now(),
    });
    t = await db('templates').where({ id }).first();
  }
  const existing = await db('automations').where({ tenant_id: req.tenant.id, event: OTP_EVENT }).first();
  const row = { template_id: t.id, variables: s({}), is_active: true };
  if (existing) await db('automations').where({ id: existing.id }).update(row);
  else await insert('automations', { tenant_id: req.tenant.id, event: OTP_EVENT, ...row });
  res.status(201).json({ template: { id: t.id, name: t.name, language: t.language, status: t.status } });
}));

/** Send a real code to a phone from the dashboard (uses 1 credit), to see what customers receive. */
r.post('/otp/test', admins, h(async (req, res) => {
  const out = await sendOtp(req.tenant, { phone: req.body?.phone, reference: 'dashboard test' });
  res.status(201).json(out);
}));

export default r;
