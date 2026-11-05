// Inbound webhooks from Meta (WhatsApp), Shopify, WooCommerce and Tap Payments.
import { Router } from 'express';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { h, hmacHex, hmacB64, safeEqual, decrypt } from '../lib/util.js';
import { enqueue } from '../lib/jobs.js';
import { createOrUpdateOrder, mapShopify, mapWoo } from '../services/commerce.js';
import { confirmTapCharge } from '../services/billing.js';

const r = Router();

// ---- Meta: verification handshake ----
r.get('/webhooks/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.meta.verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ---- Meta: events (acknowledge fast, process in the job queue) ----
r.post('/webhooks/whatsapp', h(async (req, res) => {
  if (config.meta.appSecret) {
    const sig = String(req.headers['x-hub-signature-256'] || '').replace('sha256=', '');
    if (!safeEqual(sig, hmacHex(config.meta.appSecret, req.rawBody || ''))) return res.sendStatus(401);
  }
  await enqueue('wa.webhook', req.body);
  res.sendStatus(200);
}));

async function integrationFor(type, token) {
  const i = await db('integrations').where({ type, token, is_active: true }).first();
  if (!i) return null;
  const tenant = await db('tenants').where({ id: i.tenant_id }).first();
  return tenant && tenant.status !== 'suspended' ? { i, tenant, secret: decrypt(i.secret_enc) } : null;
}

// ---- Shopify: Settings → Notifications → Webhooks (JSON) ----
r.post('/hooks/shopify/:token', h(async (req, res) => {
  const found = await integrationFor('shopify', req.params.token);
  if (!found) return res.sendStatus(404);
  const sig = req.headers['x-shopify-hmac-sha256'];
  if (!safeEqual(sig, hmacB64(found.secret, req.rawBody || ''))) return res.sendStatus(401);
  const mapped = mapShopify(req.headers['x-shopify-topic'], req.body);
  if (mapped) await createOrUpdateOrder(found.tenant, mapped);
  await db('integrations').where({ id: found.i.id }).update({ last_event_at: now() });
  res.sendStatus(200);
}));

// ---- WooCommerce: Settings → Advanced → Webhooks (order created/updated) ----
r.post('/hooks/woocommerce/:token', h(async (req, res) => {
  const found = await integrationFor('woocommerce', req.params.token);
  if (!found) return res.sendStatus(404);
  if (req.body?.webhook_id && !req.body.id) return res.sendStatus(200); // WooCommerce ping on creation
  const sig = req.headers['x-wc-webhook-signature'];
  if (!safeEqual(sig, hmacB64(found.secret, req.rawBody || ''))) return res.sendStatus(401);
  if (String(req.headers['x-wc-webhook-resource'] || 'order') === 'order' && req.body?.id) {
    await createOrUpdateOrder(found.tenant, mapWoo(req.body));
  }
  await db('integrations').where({ id: found.i.id }).update({ last_event_at: now() });
  res.sendStatus(200);
}));

// ---- Tap Payments ----
r.post('/api/billing/tap/webhook', h(async (req, res) => {
  await confirmTapCharge(req.body?.id);
  res.sendStatus(200);
}));
r.get('/api/billing/tap/return', h(async (req, res) => {
  const paid = await confirmTapCharge(req.query.tap_id);
  res.redirect(`${config.appUrl}/app/billing?payment=${paid ? 'success' : 'pending'}`);
}));

export default r;
