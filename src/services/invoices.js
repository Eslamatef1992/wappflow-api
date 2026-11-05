// Invoices a workspace sends to its own customers on WhatsApp (from its POS, website or the dashboard).
//
// How an invoice message is sent, in order:
//   1. an explicit template in the API call ("template": "invoice_ready")
//   2. the workspace's "invoice.created" message (Invoices → WhatsApp message), an approved template
//   3. a normal message with the PDF / invoice link, only while the customer's 24-hour window is open
// Otherwise the invoice is saved and send_error explains what to set up.
import { config } from '../config.js';
import { db, j, s, now, insert } from '../db.js';
import { bad, notFound, normalizePhone, randomToken } from '../lib/util.js';
import { publish } from '../lib/events.js';
import { sendToContact, buildTemplateMessage, contactCtx, isWindowOpen } from './messaging.js';
import { upsertContact } from './commerce.js';
import { assertLimit } from './billing.js';

export const INVOICE_EVENTS = ['invoice.created', 'invoice.paid'];
export const INVOICE_STATUSES = ['unpaid', 'paid', 'void'];

export const invoiceLink = (inv) => `${config.apiUrl}/i/${inv.token}`;

const money = (n, cur) => `${(+n || 0).toFixed(['KWD', 'BHD', 'OMR', 'JOD'].includes(cur) ? 3 : 2)} ${cur}`;

export function serializeInvoice(inv, extra = {}) {
  if (!inv) return inv;
  const { token, meta, items, ...rest } = inv;
  return {
    ...rest, total: +inv.total, items: j(items, []), meta: j(meta, {}),
    link: invoiceLink(inv), token, ...extra,
  };
}

export function invoiceCtx(inv, tenant) {
  const items = j(inv.items, []);
  return {
    number: inv.number, total: money(inv.total, inv.currency), amount: (+inv.total).toFixed(3), currency: inv.currency,
    due_date: inv.due_date || '', link: invoiceLink(inv), token: inv.token, pay_url: inv.pay_url || invoiceLink(inv),
    pdf_url: inv.pdf_url || '', items_count: items.length, business: tenant.name, status: inv.status,
  };
}

const cleanItems = (items) => (Array.isArray(items) ? items : []).slice(0, 200).map((it) => ({
  name: String(it.name || it.description || 'Item').slice(0, 200),
  quantity: +it.quantity || +it.qty || 1,
  price: +it.price || +it.unit_price || 0,
}));

const httpUrl = (u, field) => {
  if (!u) return null;
  if (!/^https:\/\//i.test(String(u))) throw bad(`"${field}" must be an https:// link`);
  return String(u);
};

/**
 * Create an invoice (or return the existing one with the same number, so POS retries are safe)
 * and send it on WhatsApp unless send === false.
 */
export async function createSalesInvoice(tenant, body, { source = 'api' } = {}) {
  const number = String(body.number ?? '').trim().slice(0, 64);
  if (!number) throw bad('"number" is required');
  const wa_id = normalizePhone(body.phone || body.to);
  if (!wa_id) throw bad('A valid customer "phone" is required');
  const items = cleanItems(body.items);
  const total = body.total != null && body.total !== '' ? +body.total : items.reduce((a, it) => a + it.quantity * it.price, 0);
  if (!Number.isFinite(total) || total < 0) throw bad('"total" must be a number');
  if (body.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date)) throw bad('"due_date" must look like 2026-11-30');

  const existing = await db('sales_invoices').where({ tenant_id: tenant.id, number }).first();
  if (existing) {
    if (!body.resend) return { invoice: existing, created: false, delivery: null };
    return { invoice: existing, created: false, delivery: await sendInvoice(tenant, existing, body) };
  }

  if (!(await db('contacts').where({ tenant_id: tenant.id, wa_id }).first())) await assertLimit(tenant, 'contacts', 1);
  const contact = await upsertContact(tenant.id, { phone: wa_id, name: body.name, email: body.email, source });
  const status = INVOICE_STATUSES.includes(body.status) ? body.status : 'unpaid';
  const id = await insert('sales_invoices', {
    tenant_id: tenant.id, contact_id: contact.id, number, token: randomToken(16), source, status,
    total, currency: String(body.currency || 'KWD').toUpperCase().slice(0, 8), items: s(items),
    due_date: body.due_date || null, pdf_url: httpUrl(body.pdf_url, 'pdf_url'), pay_url: httpUrl(body.pay_url, 'pay_url'),
    notes: body.notes ? String(body.notes).slice(0, 2000) : null, meta: s(body.meta || {}),
    paid_at: status === 'paid' ? now() : null, created_at: now(), updated_at: now(),
  });
  const invoice = await db('sales_invoices').where({ id }).first();
  await publish(tenant.id, 'invoice.created', { invoice: serializeInvoice(invoice) });
  const delivery = body.send === false ? null : await sendInvoice(tenant, invoice, body);
  return { invoice: await db('sales_invoices').where({ id }).first(), created: true, delivery };
}

/** Send (or resend) an invoice. Never throws for delivery problems; records them on the invoice. */
export async function sendInvoice(tenant, invoice, opts = {}, event = 'invoice.created') {
  const contact = invoice.contact_id && await db('contacts').where({ id: invoice.contact_id }).first();
  if (!contact) return record(invoice, { error: 'The invoice has no customer phone number' });
  const ctx = contactCtx(contact, { invoice: invoiceCtx(invoice, tenant), business: { name: tenant.name } });

  try {
    // 1. template named in the call
    if (opts.template) {
      const t = await db('templates').where({ tenant_id: tenant.id, name: opts.template, ...(opts.language ? { language: opts.language } : {}) }).first();
      if (!t) throw bad(`Template "${opts.template}" not found`);
      if (t.status !== 'APPROVED') throw bad(`Template "${opts.template}" is not approved yet`);
      const v = opts.variables || {};
      const asParams = (arr) => (arr || []).map((x) => ({ source: 'static', value: String(x) }));
      const message = buildTemplateMessage(t, {
        header: asParams(v.header), body: asParams(v.body), headerMedia: v.headerMedia,
        buttons: (v.buttons || []).map((x, i) => ({ index: x?.index ?? i, source: 'static', value: String(x?.value ?? x) })),
      }, ctx);
      return record(invoice, { message: await sendToContact({ tenant, contact, message, numberId: opts.numberId }), via: 'template' }, event);
    }

    // 2. the workspace's saved invoice message
    const autos = await db('automations').where({ tenant_id: tenant.id, event, is_active: true });
    for (const a of autos) {
      const t = await db('templates').where({ id: a.template_id, tenant_id: tenant.id }).first();
      if (!t || t.status !== 'APPROVED') continue;
      const message = buildTemplateMessage(t, j(a.variables, {}), ctx);
      const sent = await sendToContact({ tenant, contact, message, numberId: opts.numberId || a.wa_number_id });
      await db('automations').where({ id: a.id }).increment('runs', 1);
      return record(invoice, { message: sent, via: 'automation' }, event);
    }

    // 3. inside the 24-hour window a normal message works
    if (isWindowOpen(contact)) {
      const c = ctx.invoice;
      const text = event === 'invoice.paid'
        ? `Payment received for invoice ${c.number} (${c.total}). Thank you!\n${c.link}`
        : `Invoice ${c.number} from ${tenant.name}\nTotal: ${c.total}${c.due_date ? `\nDue: ${c.due_date}` : ''}\n\nView invoice: ${c.link}${invoice.pay_url ? `\nPay online: ${invoice.pay_url}` : ''}`;
      const message = invoice.pdf_url && event === 'invoice.created'
        ? { type: 'document', document: { link: invoice.pdf_url, filename: `Invoice-${c.number}.pdf`.replace(/[^\w.-]/g, '_'), caption: text } }
        : { type: 'text', text: { body: text, preview_url: true } };
      return record(invoice, { message: await sendToContact({ tenant, contact, message, numberId: opts.numberId }), via: 'message' }, event);
    }

    if (event === 'invoice.paid') return { sent: false, error: null };
    return record(invoice, { error: 'Not sent: the customer has not messaged you in the last 24 hours, so WhatsApp needs an approved template. Set one up in Invoices → WhatsApp message.' });
  } catch (e) {
    return record(invoice, { error: e.message, message: e.messageRecord }, event);
  }
}

async function record(invoice, { message, via, error }, event = 'invoice.created') {
  const ok = message && message.status !== 'failed' && !error;
  if (event === 'invoice.created') {
    await db('sales_invoices').where({ id: invoice.id }).update({
      message_id: message?.id ?? invoice.message_id ?? null, send_error: ok ? null : (error || message?.error || 'Message failed'),
      sent_at: ok ? now() : invoice.sent_at ?? null, updated_at: now(),
    });
  }
  return { sent: !!ok, via: ok ? via : null, message_id: message?.id ?? null, error: ok ? null : (error || message?.error || 'Message failed') };
}

export async function setInvoiceStatus(tenant, invoice, status) {
  if (!INVOICE_STATUSES.includes(status)) throw bad('status must be unpaid, paid or void');
  if (invoice.status === status) return { invoice, delivery: null };
  await db('sales_invoices').where({ id: invoice.id }).update({ status, paid_at: status === 'paid' ? now() : null, updated_at: now() });
  const fresh = await db('sales_invoices').where({ id: invoice.id }).first();
  await publish(tenant.id, `invoice.${status}`, { invoice: serializeInvoice(fresh) });
  // "payment received" message only goes out when the workspace set one up (or the window is open)
  const delivery = status === 'paid' ? await sendInvoice(tenant, fresh, {}, 'invoice.paid') : null;
  return { invoice: fresh, delivery };
}

export async function findInvoice(tenantId, { id, number }) {
  const q = db('sales_invoices').where({ tenant_id: tenantId });
  const inv = await (id != null ? q.where({ id }) : q.where({ number: String(number) })).first();
  if (!inv) throw notFound('Invoice');
  return inv;
}

/** Delivery status of the invoice message (sent → delivered → read), for lists. */
export async function withDelivery(rows) {
  const ids = rows.map((r) => r.message_id).filter(Boolean);
  const msgs = ids.length ? await db('messages').whereIn('id', ids).select('id', 'status', 'error') : [];
  const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
  return rows.map((r) => ({ ...r, message_status: byId[r.message_id]?.status || null }));
}

/** Ready-made invoice template (sent to Meta for approval) and the matching saved message. */
export function recommendedTemplate(lang, tenant) {
  const ar = lang === 'ar';
  const name = ar ? 'invoice_ready_ar' : 'invoice_ready';
  const example = `${config.apiUrl}/i/3f9c2a7b1d`;
  return {
    name, language: ar ? 'ar' : 'en', category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: ar
          ? 'مرحباً {{1}}، فاتورتك رقم {{2}} من {{3}} جاهزة.\nالإجمالي: {{4}}'
          : 'Hello {{1}}, your invoice {{2}} from {{3}} is ready.\nTotal: {{4}}',
        examples: ['Ahmad', 'INV-1042', tenant.name, '12.500 KWD'],
      },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: ar ? 'عرض الفاتورة' : 'View invoice', url: `${config.apiUrl}/i/{{1}}`, example: [example] }] },
    ],
    variables: {
      body: [
        { source: 'field', value: 'contact.first_name', fallback: ar ? 'عميلنا العزيز' : 'there' },
        { source: 'field', value: 'invoice.number' },
        { source: 'field', value: 'business.name' },
        { source: 'field', value: 'invoice.total' },
      ],
      buttons: [{ index: 0, source: 'field', value: 'invoice.token' }],
    },
  };
}
