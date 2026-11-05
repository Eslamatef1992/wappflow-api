// Processes Meta webhook payloads: inbound messages and delivery/read receipts.
// One Meta app webhook serves every tenant; events are routed by phone_number_id.
import { db, j, s, now, insert } from '../db.js';
import { publish } from '../lib/events.js';
import { registerJob } from '../lib/jobs.js';
import { previewOf, serializeMessage, getOrCreateConversation } from '../services/messaging.js';
import { addUsage } from '../services/billing.js';
import { handleInbound, inboundText } from '../services/flows.js';
import { createOrUpdateOrder, serializeContact } from '../services/commerce.js';
import { refreshCampaignCounts } from '../services/campaigns.js';
import { clientFor } from './client.js';

const STATUS_RANK = { queued: 0, failed: 1, sent: 2, delivered: 3, read: 4 };
const OPT_OUT = ['stop', 'unsubscribe', 'الغاء', 'إلغاء', 'ايقاف', 'إيقاف'];
const OPT_IN = ['start', 'subscribe', 'اشتراك'];

export async function processWebhook(body) {
  if (body?.object !== 'whatsapp_business_account') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const v = change.value || {};
      const number = await db('wa_numbers').where({ phone_number_id: v.metadata?.phone_number_id }).first();
      if (!number) continue;
      const tenant = await db('tenants').where({ id: number.tenant_id }).first();
      if (!tenant) continue;
      for (const st of v.statuses || []) await applyStatus(st);
      for (const m of v.messages || []) {
        const profile = (v.contacts || []).find((c) => c.wa_id === m.from)?.profile;
        await receiveMessage({ tenant, number, message: m, profileName: profile?.name });
      }
    }
  }
}

export async function receiveMessage({ tenant, number, message: m, profileName }) {
  if (await db('messages').where({ wamid: m.id }).first()) return; // Meta retries: dedupe

  // contact
  let contact = await db('contacts').where({ tenant_id: tenant.id, wa_id: m.from }).first();
  const isNewContact = !contact;
  if (!contact) {
    const id = await insert('contacts', {
      tenant_id: tenant.id, wa_id: m.from, name: profileName || null, source: 'whatsapp',
      attributes: s({}), opted_in: true, created_at: now(), last_inbound_at: now(),
    });
    contact = await db('contacts').where({ id }).first();
    await publish(tenant.id, 'contact.created', { contact: serializeContact(contact) });
  } else {
    await db('contacts').where({ id: contact.id }).update({ last_inbound_at: now(), ...(profileName && !contact.name ? { name: profileName } : {}) });
  }

  // opt-out / opt-in keywords
  const text = (inboundText(m) || '').trim().toLowerCase();
  if (OPT_OUT.includes(text)) await db('contacts').where({ id: contact.id }).update({ opted_in: false, opted_out_at: now() });
  if (OPT_IN.includes(text)) await db('contacts').where({ id: contact.id }).update({ opted_in: true, opted_out_at: null });

  // conversation
  let conv = await getOrCreateConversation(tenant.id, contact.id, number.id);
  const reopen = conv.status === 'resolved';
  const body = previewOf(m);
  await db('conversations').where({ id: conv.id }).update({
    last_message_at: now(), last_inbound_at: now(), last_message_preview: body.slice(0, 200), wa_number_id: number.id,
    unread_count: (conv.unread_count || 0) + 1,
    ...(reopen ? { status: 'open', bot_active: true, assigned_user_id: null, flow_session: null } : {}),
  });

  const msgId = await insert('messages', {
    tenant_id: tenant.id, conversation_id: conv.id, contact_id: contact.id, direction: 'in', type: m.type,
    content: s(m), body, wamid: m.id, status: 'received', created_at: (+m.timestamp * 1000) || now(),
  });
  await addUsage(tenant.id, 'messages_received', 1);

  // campaign reply attribution (reply within 72h of a campaign message)
  const recent = await db('campaign_recipients as r').join('campaigns as c', 'c.id', 'r.campaign_id')
    .where('c.tenant_id', tenant.id).andWhere('r.contact_id', contact.id).whereNull('r.replied_at')
    .andWhere('r.sent_at', '>', now() - 72 * 3600_000).select('r.id', 'r.campaign_id').first();
  if (recent) {
    const marked = await db('campaign_recipients').where({ id: recent.id }).whereNull('replied_at').update({ replied_at: now() });
    if (marked) await refreshCampaignCounts(recent.campaign_id);
  }

  // WhatsApp cart (customer sent an order from the catalog)
  if (m.type === 'order' && m.order) {
    const items = (m.order.product_items || []).map((i) => ({ retailer_id: i.product_retailer_id, quantity: i.quantity, price: +i.item_price, currency: i.currency }));
    const products = await db('products').where({ tenant_id: tenant.id }).whereIn('retailer_id', items.map((i) => i.retailer_id));
    items.forEach((i) => { i.name = products.find((p) => p.retailer_id === i.retailer_id)?.name || i.retailer_id; });
    await createOrUpdateOrder(tenant, {
      externalId: m.id, source: 'whatsapp', status: 'created', currency: items[0]?.currency || 'KWD',
      total: items.reduce((a, i) => a + i.price * i.quantity, 0), items, meta: { note: m.order.text },
      customer: { phone: contact.wa_id, name: contact.name },
    });
  }

  const message = serializeMessage(await db('messages').where({ id: msgId }).first());
  conv = await db('conversations').where({ id: conv.id }).first();
  await publish(tenant.id, 'message.received', { message, conversation: conv, contact: serializeContact(contact), is_new_contact: isNewContact });

  clientFor(number).markRead(m.id);

  // chatbot flows
  try {
    await handleInbound({ tenant, conv, message: m, isNewContact });
  } catch (e) {
    console.error('[flows]', e.message);
  }
}

export async function applyStatus(st) {
  const msg = await db('messages').where({ wamid: st.id }).first();
  if (!msg) return;
  const next = st.status;
  if (STATUS_RANK[next] === undefined) return;
  const error = st.errors?.[0] ? `${st.errors[0].code}: ${st.errors[0].error_data?.details || st.errors[0].title || st.errors[0].message}` : null;
  // Receipts can arrive out of order and be processed concurrently, so every transition is a
  // conditional UPDATE ("only move forward"): a late "delivered" never overwrites "read".
  const from = next === 'failed' ? ['queued', 'sent'] : Object.keys(STATUS_RANK).filter((k) => STATUS_RANK[k] < STATUS_RANK[next]);
  const changed = await db('messages').where({ id: msg.id }).whereIn('status', from).update({ status: next, ...(error ? { error } : {}) });
  if (!changed) return;

  if (msg.campaign_id) {
    const rFrom = next === 'failed' ? ['pending', 'sent'] : ['pending', ...from];
    await db('campaign_recipients').where({ wamid: st.id }).whereIn('status', rFrom).update({ status: next, ...(error ? { error } : {}) });
    await refreshCampaignCounts(msg.campaign_id);
  }
  await publish(msg.tenant_id, 'message.status', { id: msg.id, wamid: st.id, conversation_id: msg.conversation_id, status: next, error });
}

// Webhooks are acknowledged immediately and processed in the background.
registerJob('wa.webhook', async (body) => processWebhook(body));

export { j };
