// Dashboard: invoices sent to customers on WhatsApp, and the message used to send them.
import { Router } from 'express';
import { db, j, s, now, insert } from '../../db.js';
import { h, bad, notFound, paginate } from '../../lib/util.js';
import { assertFeature } from '../../services/billing.js';
import { getNumber } from '../../services/messaging.js';
import { clientFor } from '../../whatsapp/client.js';
import {
  INVOICE_EVENTS, createSalesInvoice, sendInvoice, setInvoiceStatus, findInvoice, serializeInvoice, withDelivery, recommendedTemplate,
} from '../../services/invoices.js';

const r = Router();
r.use('/invoices', h(async (req, _res, next) => { await assertFeature(req.tenant, 'invoices'); next(); }));

r.get('/invoices', h(async (req, res) => {
  const { limit, offset } = paginate(req);
  const q = db('sales_invoices as i').leftJoin('contacts as c', 'c.id', 'i.contact_id').where('i.tenant_id', req.tenant.id);
  if (req.query.status) q.where('i.status', req.query.status);
  if (req.query.q) q.where((w) => w.where('i.number', 'like', `%${req.query.q}%`).orWhere('c.name', 'like', `%${req.query.q}%`).orWhere('c.wa_id', 'like', `%${String(req.query.q).replace(/\D/g, '') || '~'}%`));
  const total = +(await q.clone().count({ c: 'i.id' }).first()).c;
  const rows = await q.select('i.*', 'c.name as contact_name', 'c.wa_id').orderBy('i.id', 'desc').limit(limit).offset(offset);
  res.json({ total, data: (await withDelivery(rows)).map((x) => serializeInvoice(x)) });
}));

r.post('/invoices', h(async (req, res) => {
  const { invoice, created, delivery } = await createSalesInvoice(req.tenant, req.body || {}, { source: 'manual' });
  if (!created) throw bad(`Invoice ${invoice.number} already exists`);
  const [row] = await withDelivery([invoice]);
  res.status(201).json({ ...serializeInvoice(row), whatsapp: delivery });
}));

r.post('/invoices/:id/send', h(async (req, res) => {
  const inv = await findInvoice(req.tenant.id, { id: req.params.id });
  const delivery = await sendInvoice(req.tenant, inv, {});
  res.json({ ...serializeInvoice(await findInvoice(req.tenant.id, { id: inv.id })), whatsapp: delivery });
}));

r.patch('/invoices/:id', h(async (req, res) => {
  const inv = await findInvoice(req.tenant.id, { id: req.params.id });
  const { invoice, delivery } = await setInvoiceStatus(req.tenant, inv, req.body?.status);
  res.json({ ...serializeInvoice(invoice), whatsapp: delivery });
}));

// ---------- the WhatsApp messages used for invoices ----------
const automation = (a) => a && { ...a, variables: j(a.variables, {}), is_active: !!a.is_active };

r.get('/invoices-setup', h(async (req, res) => {
  await assertFeature(req.tenant, 'invoices');
  const rows = await db('automations as a').leftJoin('templates as t', 't.id', 'a.template_id')
    .where('a.tenant_id', req.tenant.id).whereIn('a.event', INVOICE_EVENTS)
    .select('a.*', 't.name as template_name', 't.language as template_language', 't.status as template_status');
  res.json({ events: INVOICE_EVENTS, data: rows.map(automation) });
}));

/** Save the message for an event (one per event): { event, templateId, variables, is_active } */
r.put('/invoices-setup/:event', h(async (req, res) => {
  await assertFeature(req.tenant, 'invoices');
  const { event } = req.params;
  if (!INVOICE_EVENTS.includes(event)) throw bad('Unknown event');
  const existing = await db('automations').where({ tenant_id: req.tenant.id, event }).first();
  if (req.body.templateId == null) {
    if (existing) await db('automations').where({ id: existing.id }).del();
    return res.json({ ok: true });
  }
  const t = await db('templates').where({ id: req.body.templateId, tenant_id: req.tenant.id }).first();
  if (!t) throw notFound('Template');
  const row = { template_id: t.id, variables: s(req.body.variables || {}), is_active: req.body.is_active !== false, wa_number_id: req.body.numberId || null };
  if (existing) await db('automations').where({ id: existing.id }).update(row);
  else await insert('automations', { tenant_id: req.tenant.id, event, ...row });
  res.json(automation(await db('automations').where({ tenant_id: req.tenant.id, event }).first()));
}));

/** One click: submit the ready-made invoice template to Meta and use it for new invoices. */
r.post('/invoices-setup/recommended', h(async (req, res) => {
  await assertFeature(req.tenant, 'invoices');
  const tpl = recommendedTemplate(req.body?.language === 'ar' ? 'ar' : 'en', req.tenant);
  let t = await db('templates').where({ tenant_id: req.tenant.id, name: tpl.name, language: tpl.language }).first();
  if (!t) {
    const components = tpl.components.map(({ examples, ...c }) => (c.type === 'BODY' ? { ...c, example: { body_text: [examples] } } : c));
    const number = await getNumber(req.tenant.id, req.body?.numberId);
    const result = await clientFor(number).createTemplate({ name: tpl.name, language: tpl.language, category: tpl.category, components });
    const id = await insert('templates', {
      tenant_id: req.tenant.id, wa_number_id: number.id, meta_id: result.id, name: tpl.name, language: tpl.language,
      category: result.category || tpl.category, status: result.status || 'PENDING', components: s(components), created_at: now(), updated_at: now(),
    });
    t = await db('templates').where({ id }).first();
  }
  const existing = await db('automations').where({ tenant_id: req.tenant.id, event: 'invoice.created' }).first();
  const row = { template_id: t.id, variables: s(tpl.variables), is_active: true };
  if (existing) await db('automations').where({ id: existing.id }).update(row);
  else await insert('automations', { tenant_id: req.tenant.id, event: 'invoice.created', ...row });
  res.status(201).json({ template: { id: t.id, name: t.name, language: t.language, status: t.status } });
}));

export default r;
