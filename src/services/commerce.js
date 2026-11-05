// Orders from the dashboard, the public API, Shopify, WooCommerce and WhatsApp carts,
// plus order-event automations that send approved templates (confirmation, shipped, delivered...).
import { db, j, s, now, insert } from '../db.js';
import { normalizePhone } from '../lib/util.js';
import { publish } from '../lib/events.js';
import { sendToContact, buildTemplateMessage, contactCtx } from './messaging.js';

export const ORDER_EVENTS = ['order.created', 'order.paid', 'order.shipped', 'order.delivered', 'order.canceled'];

export async function upsertContact(tenantId, { phone, name, email, source = 'api', attributes }) {
  const wa_id = normalizePhone(phone);
  if (!wa_id) return null;
  let c = await db('contacts').where({ tenant_id: tenantId, wa_id }).first();
  if (!c) {
    const id = await insert('contacts', {
      tenant_id: tenantId, wa_id, name: name || null, email: email || null, source,
      attributes: s(attributes || {}), opted_in: true, created_at: now(),
    });
    c = await db('contacts').where({ id }).first();
    await publish(tenantId, 'contact.created', { contact: serializeContact(c) });
  } else if ((name && !c.name) || (email && !c.email) || attributes) {
    await db('contacts').where({ id: c.id }).update({
      name: c.name || name || null, email: c.email || email || null,
      ...(attributes ? { attributes: s({ ...j(c.attributes, {}), ...attributes }) } : {}),
    });
    c = await db('contacts').where({ id: c.id }).first();
  }
  return c;
}

export function serializeContact(c) {
  return c && { ...c, attributes: j(c.attributes, {}), opted_in: !!c.opted_in };
}

export function serializeOrder(o) {
  return o && { ...o, total: +o.total, items: j(o.items, []), meta: j(o.meta, {}) };
}

export async function createOrUpdateOrder(tenant, { externalId, source, status = 'created', total = 0, currency = 'KWD', items = [], meta = {}, customer }) {
  const contact = customer?.phone ? await upsertContact(tenant.id, { ...customer, source }) : null;
  let order = externalId ? await db('orders').where({ tenant_id: tenant.id, source, external_id: String(externalId) }).first() : null;
  const previousStatus = order?.status;
  if (order) {
    await db('orders').where({ id: order.id }).update({ status, total, currency, items: s(items), meta: s({ ...j(order.meta, {}), ...meta }), updated_at: now(), contact_id: order.contact_id || contact?.id || null });
  } else {
    const id = await insert('orders', {
      tenant_id: tenant.id, contact_id: contact?.id || null, external_id: externalId ? String(externalId) : null, source,
      status, total, currency, items: s(items), meta: s(meta), created_at: now(), updated_at: now(),
    });
    order = { id };
  }
  order = await db('orders').where({ id: order.id }).first();
  if (previousStatus !== status) {
    const event = previousStatus ? `order.${status}` : 'order.created';
    await publish(tenant.id, event, { order: serializeOrder(order) });
    await runAutomations(tenant, event, order);
    if (!previousStatus && status !== 'created') await runAutomations(tenant, `order.${status}`, order);
  }
  return serializeOrder(order);
}

export async function setOrderStatus(tenant, order, status, meta = {}) {
  if (order.status === status && !Object.keys(meta).length) return serializeOrder(order);
  await db('orders').where({ id: order.id }).update({ status, meta: s({ ...j(order.meta, {}), ...meta }), updated_at: now() });
  const fresh = await db('orders').where({ id: order.id }).first();
  if (order.status !== status) {
    await publish(tenant.id, `order.${status}`, { order: serializeOrder(fresh) });
    await runAutomations(tenant, `order.${status}`, fresh);
  }
  return serializeOrder(fresh);
}

export async function runAutomations(tenant, event, order) {
  if (!order.contact_id) return;
  const autos = await db('automations').where({ tenant_id: tenant.id, event, is_active: true });
  if (!autos.length) return;
  const contact = await db('contacts').where({ id: order.contact_id }).first();
  const o = serializeOrder(order);
  const ctx = contactCtx(contact, {
    order: { ...o, number: o.external_id || o.id, items_count: o.items.length, total: `${o.total.toFixed(3)} ${o.currency}`, tracking_url: o.meta?.tracking_url || '' },
  });
  for (const a of autos) {
    const template = await db('templates').where({ id: a.template_id, tenant_id: tenant.id }).first();
    if (!template || template.status !== 'APPROVED') continue;
    try {
      await sendToContact({ tenant, contact, numberId: a.wa_number_id, message: buildTemplateMessage(template, j(a.variables, {}), ctx) });
      await db('automations').where({ id: a.id }).increment('runs', 1);
    } catch (e) {
      console.warn(`[automation ${a.id}] ${e.message}`);
    }
  }
}

// ---- Shopify / WooCommerce payload mapping ----
export function mapShopify(topic, p) {
  const statusByTopic = { 'orders/create': 'created', 'orders/paid': 'paid', 'orders/fulfilled': 'shipped', 'orders/cancelled': 'canceled' };
  const status = statusByTopic[topic];
  if (!status) return null;
  const addr = p.shipping_address || p.billing_address || {};
  const cust = p.customer || {};
  return {
    externalId: p.id, source: 'shopify', status, total: +p.total_price || 0, currency: p.currency || 'KWD',
    items: (p.line_items || []).map((l) => ({ name: l.title, quantity: l.quantity, price: +l.price, sku: l.sku })),
    meta: { name: p.name, tracking_url: p.fulfillments?.[0]?.tracking_url || undefined, order_status_url: p.order_status_url },
    customer: {
      phone: p.phone || cust.phone || addr.phone,
      name: [cust.first_name || addr.first_name, cust.last_name || addr.last_name].filter(Boolean).join(' '),
      email: p.email || cust.email,
    },
  };
}

export function mapWoo(p) {
  const map = { pending: 'created', 'on-hold': 'created', processing: 'paid', completed: 'delivered', cancelled: 'canceled', refunded: 'canceled', shipped: 'shipped' };
  const status = map[p.status] || 'created';
  const b = p.billing || {};
  return {
    externalId: p.id, source: 'woocommerce', status, total: +p.total || 0, currency: p.currency || 'KWD',
    items: (p.line_items || []).map((l) => ({ name: l.name, quantity: l.quantity, price: +l.price, sku: l.sku })),
    meta: { number: p.number },
    customer: { phone: b.phone || p.shipping?.phone, name: [b.first_name, b.last_name].filter(Boolean).join(' '), email: b.email },
  };
}
