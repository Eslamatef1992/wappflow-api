// Single entry point for every outbound WhatsApp message (inbox, campaigns, flows, API, automations).
import { config } from '../config.js';
import { db, j, s, now, insert } from '../db.js';
import { bad, render } from '../lib/util.js';
import { publish } from '../lib/events.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { clientFor } from '../whatsapp/client.js';
import { addUsage, assertLimit } from './billing.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getNumber(tenantId, numberId) {
  const q = db('wa_numbers').where({ tenant_id: tenantId });
  const n = numberId ? await q.andWhere({ id: numberId }).first() : await q.orderBy([{ column: 'is_default', order: 'desc' }, 'id']).first();
  if (!n) throw bad('No WhatsApp number connected. Add one in Settings → WhatsApp numbers.');
  return n;
}

export async function getOrCreateConversation(tenantId, contactId, waNumberId) {
  let conv = await db('conversations').where({ tenant_id: tenantId, contact_id: contactId }).orderBy('id', 'desc').first();
  if (!conv) {
    const id = await insert('conversations', {
      tenant_id: tenantId, contact_id: contactId, wa_number_id: waNumberId, status: 'open',
      bot_active: true, unread_count: 0, created_at: now(), last_message_at: now(),
    });
    conv = await db('conversations').where({ id }).first();
  }
  return conv;
}

export function isWindowOpen(contact) {
  return !!contact.last_inbound_at && now() - contact.last_inbound_at < WINDOW_MS;
}

/** Human-readable preview of any outgoing/incoming message object. */
export function previewOf(msg) {
  switch (msg.type) {
    case 'text': return msg.text?.body || '';
    case 'template': return msg._preview || `Template: ${msg.template?.name}`;
    case 'image': case 'video': case 'document': case 'audio': case 'sticker':
      return msg[msg.type]?.caption || `[${msg.type}${msg[msg.type]?.filename ? `: ${msg[msg.type].filename}` : ''}]`;
    case 'interactive': {
      const i = msg.interactive || {};
      if (i.type === 'button_reply' || i.type === 'list_reply') return i[i.type]?.title || '';
      if (i.type === 'nfm_reply') return '[Form response]';
      return i.body?.text || `[${i.type}]`;
    }
    case 'button': return msg.button?.text || '';
    case 'location': return `📍 ${msg.location?.name || `${msg.location?.latitude},${msg.location?.longitude}`}`;
    case 'order': return `🛒 Order (${msg.order?.product_items?.length || 0} items)`;
    case 'contacts': return '[Contact card]';
    case 'reaction': return `Reacted ${msg.reaction?.emoji || ''}`;
    default: return `[${msg.type}]`;
  }
}

// ---------------- Template rendering ----------------
// Template components are stored in Meta format. Variable mapping per campaign/automation:
// { header: [{source:'static'|'field'|'attribute', value}], headerMedia: 'https://...', body: [...], buttons: [{index, value}] }
function resolveParam(p, ctx) {
  if (!p) return '';
  if (p.source === 'field') return render(`{{${p.value}}}`, ctx) || p.fallback || '';
  if (p.source === 'attribute') return ctx.contact?.attributes?.[p.value] ?? p.fallback ?? '';
  return render(p.value, ctx); // static text may itself contain {{contact.name}}
}

export function buildTemplateMessage(template, variables = {}, ctx = {}) {
  const comps = j(template.components, []);
  const out = [];
  const header = comps.find((c) => c.type === 'HEADER');
  const body = comps.find((c) => c.type === 'BODY');
  const buttons = comps.find((c) => c.type === 'BUTTONS');

  if (header) {
    if (header.format === 'TEXT' && /\{\{\d+\}\}/.test(header.text || '')) {
      out.push({ type: 'header', parameters: (variables.header || []).map((p) => ({ type: 'text', text: String(resolveParam(p, ctx) || '-') })) });
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) {
      const kind = header.format.toLowerCase();
      const link = variables.headerMedia || header.example?.header_handle?.[0];
      if (!link) throw bad(`Template "${template.name}" needs a header ${kind} URL`);
      out.push({ type: 'header', parameters: [{ type: kind, [kind]: { link } }] });
    }
  }
  const bodyVars = (body?.text?.match(/\{\{\d+\}\}/g) || []).length;
  if (bodyVars) {
    const params = [];
    for (let i = 0; i < bodyVars; i++) params.push({ type: 'text', text: String(resolveParam(variables.body?.[i], ctx) || '-') });
    out.push({ type: 'body', parameters: params });
  }
  (buttons?.buttons || []).forEach((b, index) => {
    if (b.type === 'URL' && /\{\{1\}\}/.test(b.url || '')) {
      const v = variables.buttons?.find((x) => +x.index === index);
      out.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: String(resolveParam(v, ctx) || '') }] });
    }
  });

  // plain-text preview for the inbox
  let preview = body?.text || template.name;
  out.find((c) => c.type === 'body')?.parameters.forEach((p, i) => { preview = preview.replaceAll(`{{${i + 1}}}`, p.text); });

  return {
    type: 'template',
    template: { name: template.name, language: { code: template.language }, ...(out.length ? { components: out } : {}) },
    _preview: preview,
  };
}

export function contactCtx(contact, extra = {}) {
  const attrs = j(contact.attributes, {});
  const first = (contact.name || '').split(' ')[0];
  return { contact: { ...contact, attributes: attrs, first_name: first, phone: `+${contact.wa_id}` }, ...extra };
}

// ---------------- Send ----------------
/**
 * Send a message to a contact. Creates/updates the conversation, stores the message,
 * enforces the 24h customer-service window and plan limits, and publishes realtime events.
 */
export async function sendToContact({ tenant, contact, message, numberId, userId = null, campaignId = null, flowId = null, skipWindowCheck = false }) {
  if (!contact.opted_in && message.type === 'template' && campaignId) throw bad('Contact has opted out of marketing');
  if (message.type !== 'template' && !skipWindowCheck && !isWindowOpen(contact)) {
    throw bad('The 24-hour window is closed for this contact. Send an approved template to restart the conversation.');
  }
  await assertLimit(tenant, 'monthly_messages', 1);

  const number = await getNumber(tenant.id, numberId);
  const conv = await getOrCreateConversation(tenant.id, contact.id, number.id);
  const { _preview, ...payload } = message;
  const body = previewOf(message);

  const msgId = await insert('messages', {
    tenant_id: tenant.id, conversation_id: conv.id, contact_id: contact.id, direction: 'out', type: payload.type,
    content: s(payload), body, status: 'queued', sender_user_id: userId, campaign_id: campaignId, flow_id: flowId, created_at: now(),
  });

  let wamid = null;
  let status = 'sent';
  let error = null;
  try {
    wamid = await clientFor(number).send(contact.wa_id, payload);
  } catch (e) {
    status = 'failed';
    error = e.message;
  }
  await db('messages').where({ id: msgId }).update({ wamid, status, error });
  await db('conversations').where({ id: conv.id }).update({
    last_message_at: now(), last_message_preview: body.slice(0, 200), wa_number_id: number.id,
    ...(userId && conv.status === 'resolved' ? { status: 'open' } : {}),
  });

  if (status === 'sent') {
    await addUsage(tenant.id, 'messages_sent', 1);
    if (payload.type === 'template') await addUsage(tenant.id, 'templates_sent', 1);
    if (number.mode === 'mock') {
      await enqueue('mock.status', { wamid, status: 'delivered' }, { delayMs: config.mockStatusDelayMs });
      await enqueue('mock.status', { wamid, status: 'read' }, { delayMs: config.mockStatusDelayMs * 3 });
    }
  }

  const saved = await db('messages').where({ id: msgId }).first();
  const out = serializeMessage(saved);
  await publish(tenant.id, 'message.sent', { message: out, conversation_id: conv.id, contact_id: contact.id });
  if (status === 'failed') {
    const err = bad(error || 'Message failed');
    err.messageRecord = out;
    throw err;
  }
  return out;
}

export function serializeMessage(m) {
  return m && { ...m, content: j(m.content, {}) };
}

// Simulated delivery receipts for mock numbers.
registerJob('mock.status', async ({ wamid, status }) => {
  const { applyStatus } = await import('../whatsapp/inbound.js');
  await applyStatus({ id: wamid, status, timestamp: Math.floor(now() / 1000) });
});
