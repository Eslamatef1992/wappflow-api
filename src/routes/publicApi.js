// Public REST API for tenants' own systems (ERP, website, mobile app). Auth: API key.
import { Router } from 'express';
import { db, j } from '../db.js';
import { h, bad, notFound, required, normalizePhone } from '../lib/util.js';
import { requireApiKey } from '../lib/auth.js';
import { assertFeature, assertLimit } from '../services/billing.js';
import { sendToContact, buildTemplateMessage, contactCtx } from '../services/messaging.js';
import { upsertContact, serializeContact, createOrUpdateOrder, setOrderStatus } from '../services/commerce.js';

const r = Router();
r.use(requireApiKey, h(async (req, _res, next) => { await assertFeature(req.tenant, 'api'); next(); }));

async function contactFromBody(req) {
  required(req.body, ['to']);
  const wa_id = normalizePhone(req.body.to);
  if (!wa_id) throw bad('Invalid "to" phone number');
  if (!(await db('contacts').where({ tenant_id: req.tenant.id, wa_id }).first())) await assertLimit(req.tenant, 'contacts', 1);
  return upsertContact(req.tenant.id, { phone: wa_id, name: req.body.name, source: 'api' });
}

/**
 * POST /api/v1/messages
 *  { "to": "+96550000000", "template": "order_update", "language": "en", "variables": { "body": ["Ali", "#1042"] } }
 *  { "to": "+96550000000", "text": "Hello" }   (only inside the 24h window)
 */
r.post('/messages', h(async (req, res) => {
  const contact = await contactFromBody(req);
  let message;
  if (req.body.template) {
    const t = await db('templates').where({ tenant_id: req.tenant.id, name: req.body.template, ...(req.body.language ? { language: req.body.language } : {}) }).first();
    if (!t) throw notFound(`Template "${req.body.template}"`);
    if (t.status !== 'APPROVED') throw bad('Template is not approved');
    const v = req.body.variables || {};
    const asParams = (arr) => (arr || []).map((x) => ({ source: 'static', value: String(x) }));
    message = buildTemplateMessage(t, { header: asParams(v.header), body: asParams(v.body), headerMedia: v.headerMedia, buttons: (v.buttons || []).map((x, i) => ({ index: x.index ?? i, source: 'static', value: String(x.value ?? x) })) }, contactCtx(contact));
  } else if (req.body.text) {
    message = { type: 'text', text: { body: String(req.body.text), preview_url: true } };
  } else if (req.body.media?.url) {
    const kind = req.body.media.type || 'image';
    message = { type: kind, [kind]: { link: req.body.media.url, ...(req.body.media.caption ? { caption: req.body.media.caption } : {}), ...(req.body.media.filename ? { filename: req.body.media.filename } : {}) } };
  } else throw bad('Provide "template", "text" or "media"');
  const sent = await sendToContact({ tenant: req.tenant, contact, message, numberId: req.body.numberId });
  res.status(201).json({ id: sent.id, wamid: sent.wamid, status: sent.status, conversation_id: sent.conversation_id });
}));

r.get('/messages/:id', h(async (req, res) => {
  const m = await db('messages').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!m) throw notFound('Message');
  res.json({ id: m.id, wamid: m.wamid, direction: m.direction, type: m.type, body: m.body, status: m.status, error: m.error, created_at: m.created_at });
}));

r.post('/contacts', h(async (req, res) => {
  const wa_id = normalizePhone(req.body.phone);
  if (!wa_id) throw bad('Invalid phone');
  const exists = await db('contacts').where({ tenant_id: req.tenant.id, wa_id }).first();
  if (!exists) await assertLimit(req.tenant, 'contacts', 1);
  const c = await upsertContact(req.tenant.id, { phone: wa_id, name: req.body.name, email: req.body.email, attributes: req.body.attributes, source: 'api' });
  if (req.body.tags?.length) {
    for (const name of req.body.tags) {
      let tag = await db('tags').where({ tenant_id: req.tenant.id, name }).first();
      if (!tag) { const [id] = await db('tags').insert({ tenant_id: req.tenant.id, name }, ['id']); tag = { id: typeof id === 'object' ? id.id : id }; }
      if (!(await db('contact_tags').where({ contact_id: c.id, tag_id: tag.id }).first())) await db('contact_tags').insert({ contact_id: c.id, tag_id: tag.id });
    }
  }
  res.status(exists ? 200 : 201).json(serializeContact(await db('contacts').where({ id: c.id }).first()));
}));

r.get('/contacts/:phone', h(async (req, res) => {
  const c = await db('contacts').where({ tenant_id: req.tenant.id, wa_id: normalizePhone(req.params.phone) }).first();
  if (!c) throw notFound('Contact');
  res.json(serializeContact(c));
}));

r.get('/templates', h(async (req, res) => {
  const rows = await db('templates').where({ tenant_id: req.tenant.id, status: 'APPROVED' });
  res.json(rows.map((t) => ({ name: t.name, language: t.language, category: t.category, components: j(t.components, []) })));
}));

/** Orders from your store/ERP → triggers order automations (confirmation, shipped, delivered...). */
r.post('/orders', h(async (req, res) => {
  await assertFeature(req.tenant, 'commerce');
  required(req.body, ['id', 'phone']);
  const order = await createOrUpdateOrder(req.tenant, {
    externalId: req.body.id, source: 'api', status: req.body.status || 'created', total: +req.body.total || 0,
    currency: req.body.currency || 'KWD', items: req.body.items || [], meta: req.body.meta || {},
    customer: { phone: req.body.phone, name: req.body.name, email: req.body.email },
  });
  res.status(201).json(order);
}));

r.patch('/orders/:id', h(async (req, res) => {
  await assertFeature(req.tenant, 'commerce');
  const o = await db('orders').where({ tenant_id: req.tenant.id, external_id: String(req.params.id) }).first();
  if (!o) throw notFound('Order');
  if (!['created', 'paid', 'shipped', 'delivered', 'canceled'].includes(req.body.status)) throw bad('Invalid status');
  res.json(await setOrderStatus(req.tenant, o, req.body.status, req.body.meta || {}));
}));

export default r;
