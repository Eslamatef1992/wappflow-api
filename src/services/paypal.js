// PayPal Checkout (Orders API v2) for subscription invoices.
// Flow: createPaypalOrder → customer approves on PayPal → return URL / webhook → capturePaypalOrder.
// An invoice is marked paid only after we capture the order with PayPal's API ourselves;
// nothing in the browser redirect or the webhook body is trusted on its own.
import { config } from '../config.js';
import { db, now } from '../db.js';
import { bad } from '../lib/util.js';
import { markInvoicePaid } from './billing.js';

// Currencies PayPal can charge in (KWD, SAR, AED... are not among them).
const SUPPORTED = new Set(['AUD', 'BRL', 'CAD', 'CNY', 'CZK', 'DKK', 'EUR', 'HKD', 'HUF', 'ILS', 'JPY', 'MYR', 'MXN', 'TWD', 'NZD', 'NOK', 'PHP', 'PLN', 'GBP', 'SGD', 'SEK', 'CHF', 'THB', 'USD']);
const NO_DECIMALS = new Set(['HUF', 'JPY', 'TWD']);

export const paypalEnabled = () => !!(config.paypal.clientId && config.paypal.secret);

const apiBase = () => config.paypal.apiBase
  || (config.paypal.mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');

/** Amount PayPal will charge for an invoice: same currency if supported, otherwise converted. */
export function paypalAmount(invoice) {
  const cur = String(invoice.currency || 'USD').toUpperCase();
  const amount = +invoice.amount;
  const target = SUPPORTED.has(cur) ? cur : config.paypal.currency;
  const value = target === cur ? amount : amount * config.paypal.fxRate;
  const rounded = NO_DECIMALS.has(target) ? Math.ceil(value) : Math.ceil(value * 100) / 100;
  return { currency: target, value: NO_DECIMALS.has(target) ? String(rounded) : rounded.toFixed(2), converted: target !== cur };
}

let tokenCache = { token: null, expires: 0 };
async function accessToken() {
  if (tokenCache.token && tokenCache.expires > now() + 60_000) return tokenCache.token;
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.paypal.clientId}:${config.paypal.secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw bad('PayPal sign-in failed. Check PAYPAL_CLIENT_ID, PAYPAL_SECRET and PAYPAL_MODE.');
  tokenCache = { token: data.access_token, expires: now() + (data.expires_in || 300) * 1000 };
  return tokenCache.token;
}

async function paypal(method, path, body, headers = {}) {
  const res = await fetch(apiBase() + path, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

/** Create a PayPal order for an unpaid invoice and return the approval URL for the customer. */
export async function createPaypalOrder(invoice, tenant) {
  if (!paypalEnabled()) throw bad('PayPal is not configured on this server.');
  if (invoice.status !== 'unpaid') throw bad(`Invoice is ${invoice.status}`);
  const amount = paypalAmount(invoice);
  const { ok, data } = await paypal('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: invoice.number,
      custom_id: String(invoice.id),
      description: `${config.brand} ${invoice.number}${invoice.notes ? ` · ${invoice.notes}` : ''}`.slice(0, 127),
      amount: { currency_code: amount.currency, value: amount.value },
    }],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: config.brand.slice(0, 127),
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${config.apiUrl}/api/billing/paypal/return`,
          cancel_url: `${config.appUrl}/app/billing?payment=canceled`,
        },
      },
    },
  }, { 'PayPal-Request-Id': `wf-${invoice.id}-${now()}` });
  if (!ok) throw bad(data?.details?.[0]?.description || data?.message || 'Could not start the PayPal payment');
  const approve = (data.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!approve) throw bad('PayPal did not return a payment link');
  await db('invoices').where({ id: invoice.id }).update({ provider: 'paypal', provider_ref: data.id });
  return { url: approve.href, orderId: data.id, amount };
}

/**
 * Capture an approved order and mark its invoice paid. Safe to call repeatedly (return URL,
 * webhook, or a manual "check payment") — an already captured order just re-confirms.
 * Returns the paid invoice, or null when the order is not (yet) paid.
 */
export async function capturePaypalOrder(orderId) {
  if (!paypalEnabled() || !orderId) return null;
  const inv = await db('invoices').where({ provider: 'paypal', provider_ref: String(orderId) }).first();
  if (!inv) return null; // not an order we created
  if (inv.status === 'paid') return inv;

  let { ok, data: order } = await paypal('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  if (!ok) return null;
  if (order.status === 'APPROVED') {
    const cap = await paypal('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {}, { 'PayPal-Request-Id': `wf-cap-${orderId}` });
    // ORDER_ALREADY_CAPTURED etc.: re-read the order and decide from its real state
    order = cap.ok ? cap.data : (await paypal('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`)).data;
  }
  if (order?.status !== 'COMPLETED') return null;

  const unit = order.purchase_units?.[0] || {};
  const capture = unit.payments?.captures?.find((c) => c.status === 'COMPLETED');
  if (!capture) return null;
  if (String(unit.custom_id || capture.custom_id || '') !== String(inv.id)) return null;
  // the captured amount must equal what we asked PayPal to charge for this invoice
  const expected = paypalAmount(inv);
  const paidValue = +capture.amount?.value;
  if (capture.amount?.currency_code !== expected.currency || Math.abs(paidValue - +expected.value) > 0.011) {
    // rate may have been changed between order and capture: accept the amount PayPal itself agreed on
    const ordered = unit.amount;
    if (!(ordered && ordered.currency_code === capture.amount?.currency_code && Math.abs(+ordered.value - paidValue) < 0.011)) return null;
  }
  return markInvoicePaid(inv.id, { provider: 'paypal', ref: capture.id });
}

/** Webhook: resolve the order id from the event and capture/confirm it via the API. */
export async function handlePaypalWebhook(event) {
  const r = event?.resource || {};
  const orderId = event?.event_type?.startsWith('CHECKOUT.ORDER') ? r.id : r.supplementary_data?.related_ids?.order_id;
  return orderId ? capturePaypalOrder(orderId) : null;
}
