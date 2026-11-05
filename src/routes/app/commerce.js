import { Router } from 'express';
import { db, j, s, now, insert } from '../../db.js';
import { config } from '../../config.js';
import { h, bad, notFound, required, paginate, encrypt, randomToken } from '../../lib/util.js';
import { assertFeature } from '../../services/billing.js';
import { createOrUpdateOrder, setOrderStatus, serializeOrder, ORDER_EVENTS } from '../../services/commerce.js';

const r = Router();
for (const p of ['/products', '/orders', '/automations', '/integrations']) {
  r.use(p, h(async (req, _res, next) => { await assertFeature(req.tenant, 'commerce'); next(); }));
}

// ---------- products ----------
const product = (p) => p && { ...p, price: +p.price, is_active: !!p.is_active };
r.get('/products', h(async (req, res) => {
  const q = db('products').where({ tenant_id: req.tenant.id });
  if (req.query.q) q.where('name', 'like', `%${req.query.q}%`);
  res.json((await q.orderBy('id', 'desc')).map(product));
}));
function productPayload(b) {
  return {
    name: b.name, description: b.description || null, price: +b.price || 0, currency: (b.currency || 'KWD').toUpperCase(),
    sku: b.sku || null, retailer_id: b.retailer_id || b.sku || null, image_url: b.image_url || null, is_active: b.is_active !== false,
  };
}
r.post('/products', h(async (req, res) => {
  required(req.body, ['name']);
  const id = await insert('products', { tenant_id: req.tenant.id, ...productPayload(req.body), created_at: now() });
  res.status(201).json(product(await db('products').where({ id }).first()));
}));
r.put('/products/:id', h(async (req, res) => {
  await db('products').where({ id: req.params.id, tenant_id: req.tenant.id }).update(productPayload(req.body));
  res.json(product(await db('products').where({ id: req.params.id }).first()));
}));
r.delete('/products/:id', h(async (req, res) => {
  await db('products').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

// ---------- orders ----------
r.get('/orders', h(async (req, res) => {
  const { limit, offset } = paginate(req);
  const q = db('orders as o').leftJoin('contacts as c', 'c.id', 'o.contact_id').where('o.tenant_id', req.tenant.id);
  if (req.query.status) q.where('o.status', req.query.status);
  if (req.query.source) q.where('o.source', req.query.source);
  const total = +(await q.clone().count({ c: 'o.id' }).first()).c;
  const rows = await q.select('o.*', 'c.name as contact_name', 'c.wa_id').orderBy('o.id', 'desc').limit(limit).offset(offset);
  res.json({ total, data: rows.map(serializeOrder) });
}));
r.post('/orders', h(async (req, res) => {
  required(req.body, ['phone']);
  const order = await createOrUpdateOrder(req.tenant, {
    externalId: req.body.externalId || null, source: 'manual', status: req.body.status || 'created',
    total: +req.body.total || 0, currency: req.body.currency || 'KWD', items: req.body.items || [], meta: req.body.meta || {},
    customer: { phone: req.body.phone, name: req.body.name, email: req.body.email },
  });
  res.status(201).json(order);
}));
r.patch('/orders/:id', h(async (req, res) => {
  const o = await db('orders').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!o) throw notFound('Order');
  if (!['created', 'paid', 'shipped', 'delivered', 'canceled'].includes(req.body.status)) throw bad('Invalid status');
  res.json(await setOrderStatus(req.tenant, o, req.body.status, req.body.tracking_url ? { tracking_url: req.body.tracking_url } : {}));
}));

// ---------- automations (order event → template) ----------
const automation = (a) => a && { ...a, variables: j(a.variables, {}), is_active: !!a.is_active };
r.get('/automations', h(async (req, res) => {
  const rows = await db('automations as a').leftJoin('templates as t', 't.id', 'a.template_id').where('a.tenant_id', req.tenant.id).select('a.*', 't.name as template_name');
  res.json({ events: ORDER_EVENTS, data: rows.map(automation) });
}));
r.post('/automations', h(async (req, res) => {
  required(req.body, ['event', 'templateId']);
  if (!ORDER_EVENTS.includes(req.body.event)) throw bad('Unknown event');
  if (!(await db('templates').where({ id: req.body.templateId, tenant_id: req.tenant.id }).first())) throw notFound('Template');
  const id = await insert('automations', { tenant_id: req.tenant.id, event: req.body.event, template_id: req.body.templateId, wa_number_id: req.body.numberId || null, variables: s(req.body.variables || {}), is_active: true });
  res.status(201).json(automation(await db('automations').where({ id }).first()));
}));
r.put('/automations/:id', h(async (req, res) => {
  const patch = {};
  if (req.body.templateId) patch.template_id = req.body.templateId;
  if (req.body.event) patch.event = req.body.event;
  if (req.body.variables) patch.variables = s(req.body.variables);
  if (req.body.is_active !== undefined) patch.is_active = !!req.body.is_active;
  await db('automations').where({ id: req.params.id, tenant_id: req.tenant.id }).update(patch);
  res.json(automation(await db('automations').where({ id: req.params.id }).first()));
}));
r.delete('/automations/:id', h(async (req, res) => {
  await db('automations').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

// ---------- store integrations (Shopify / WooCommerce webhooks) ----------
const integration = (i) => i && ({
  id: i.id, type: i.type, name: i.name, is_active: !!i.is_active, last_event_at: i.last_event_at, created_at: i.created_at,
  webhook_url: `${config.apiUrl}/hooks/${i.type}/${i.token}`,
});
r.get('/integrations', h(async (req, res) => {
  res.json((await db('integrations').where({ tenant_id: req.tenant.id })).map(integration));
}));
r.post('/integrations', h(async (req, res) => {
  required(req.body, ['type', 'secret']);
  if (!['shopify', 'woocommerce'].includes(req.body.type)) throw bad('Supported: shopify, woocommerce');
  const id = await insert('integrations', {
    tenant_id: req.tenant.id, type: req.body.type, name: req.body.name || req.body.type, token: randomToken(18),
    secret_enc: encrypt(req.body.secret), is_active: true, created_at: now(),
  });
  res.status(201).json(integration(await db('integrations').where({ id }).first()));
}));
r.delete('/integrations/:id', h(async (req, res) => {
  await db('integrations').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

export default r;
