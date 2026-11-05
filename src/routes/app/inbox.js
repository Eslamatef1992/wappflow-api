import { Router } from 'express';
import { db, j, now, insert, s } from '../../db.js';
import { h, bad, notFound, required, normalizePhone } from '../../lib/util.js';
import { publish } from '../../lib/events.js';
import { sendToContact, serializeMessage, isWindowOpen, buildTemplateMessage, contactCtx, getNumber, getOrCreateConversation } from '../../services/messaging.js';
import { serializeContact, upsertContact } from '../../services/commerce.js';
import { assertLimit } from '../../services/billing.js';
import { clientFor } from '../../whatsapp/client.js';
import { receiveMessage } from '../../whatsapp/inbound.js';

const r = Router();

const isAgent = (req) => req.user.role === 'agent';

async function loadConv(req) {
  const conv = await db('conversations').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!conv) throw notFound('Conversation');
  if (isAgent(req) && conv.assigned_user_id && conv.assigned_user_id !== req.user.id) throw notFound('Conversation');
  return conv;
}

r.get('/conversations', h(async (req, res) => {
  const q = db('conversations as cv').join('contacts as c', 'c.id', 'cv.contact_id').where('cv.tenant_id', req.tenant.id);
  const status = req.query.status || 'open';
  if (status !== 'all') q.where('cv.status', status);
  const assigned = req.query.assigned || (isAgent(req) ? 'mine_or_unassigned' : 'all');
  if (assigned === 'me') q.where('cv.assigned_user_id', req.user.id);
  else if (assigned === 'unassigned') q.whereNull('cv.assigned_user_id');
  else if (assigned === 'bot') q.where('cv.bot_active', true);
  if (isAgent(req) || assigned === 'mine_or_unassigned') q.where((w) => w.where('cv.assigned_user_id', req.user.id).orWhereNull('cv.assigned_user_id'));
  if (req.query.q) {
    const term = `%${req.query.q}%`;
    q.where((w) => w.where('c.name', 'like', term).orWhere('c.wa_id', 'like', term).orWhere('cv.last_message_preview', 'like', term));
  }
  if (req.query.tag) q.whereIn('c.id', db('contact_tags').where({ tag_id: +req.query.tag }).select('contact_id'));
  const rows = await q.select('cv.*', 'c.name as contact_name', 'c.wa_id', 'c.last_inbound_at as contact_last_inbound_at')
    .orderBy('cv.last_message_at', 'desc').limit(Math.min(+req.query.limit || 100, 300));
  const counts = await db('conversations').where({ tenant_id: req.tenant.id }).groupBy('status').select('status').count({ c: '*' });
  res.json({
    counts: Object.fromEntries(counts.map((x) => [x.status, +x.c])),
    data: rows.map((x) => ({ ...x, flow_session: undefined, bot_active: !!x.bot_active, window_open: !!x.contact_last_inbound_at && now() - x.contact_last_inbound_at < 86400000 })),
  });
}));

r.post('/conversations/start', h(async (req, res) => {
  let contact;
  if (req.body.contactId) contact = await db('contacts').where({ id: req.body.contactId, tenant_id: req.tenant.id }).first();
  else if (req.body.phone) {
    if (!normalizePhone(req.body.phone)) throw bad('Invalid phone number');
    const exists = await db('contacts').where({ tenant_id: req.tenant.id, wa_id: normalizePhone(req.body.phone) }).first();
    if (!exists) await assertLimit(req.tenant, 'contacts', 1);
    contact = await upsertContact(req.tenant.id, { phone: req.body.phone, name: req.body.name, source: 'manual' });
  }
  if (!contact) throw notFound('Contact');
  const number = await getNumber(req.tenant.id, req.body.numberId);
  const conv = await getOrCreateConversation(req.tenant.id, contact.id, number.id);
  res.json({ id: conv.id });
}));

r.get('/conversations/:id', h(async (req, res) => {
  const conv = await loadConv(req);
  const contact = await db('contacts').where({ id: conv.contact_id }).first();
  const tags = await db('contact_tags as ct').join('tags as t', 't.id', 'ct.tag_id').where('ct.contact_id', contact.id).select('t.*');
  const orders = await db('orders').where({ contact_id: contact.id }).orderBy('id', 'desc').limit(5);
  const session = j(conv.flow_session);
  res.json({
    ...conv, bot_active: !!conv.bot_active, flow_session: session,
    window_open: isWindowOpen(contact),
    window_expires_at: contact.last_inbound_at ? contact.last_inbound_at + 86400000 : null,
    contact: { ...serializeContact(contact), tags },
    orders: orders.map((o) => ({ ...o, total: +o.total, items: j(o.items, []) })),
  });
}));

r.get('/conversations/:id/messages', h(async (req, res) => {
  const conv = await loadConv(req);
  const q = db('messages as m').leftJoin('users as u', 'u.id', 'm.sender_user_id').where('m.conversation_id', conv.id);
  if (req.query.before) q.where('m.id', '<', +req.query.before);
  const rows = await q.select('m.*', 'u.name as sender_name').orderBy('m.id', 'desc').limit(Math.min(+req.query.limit || 50, 200));
  res.json(rows.reverse().map(serializeMessage));
}));

/**
 * Send from the inbox. Body:
 *  { type:'text', text }  |  { type:'template', templateId, variables }
 *  { type:'media', kind:'image'|'document'|'video'|'audio', url, caption, filename }
 *  { type:'buttons', text, buttons:['Yes','No'] }  |  { type:'product', catalogId, retailerId, text }
 */
r.post('/conversations/:id/messages', h(async (req, res) => {
  const conv = await loadConv(req);
  const contact = await db('contacts').where({ id: conv.contact_id }).first();
  const b = req.body;
  let message;
  if (b.type === 'text') {
    required(b, ['text']);
    message = { type: 'text', text: { body: String(b.text).slice(0, 4096), preview_url: /https?:\/\//.test(b.text) } };
  } else if (b.type === 'template') {
    const t = await db('templates').where({ id: b.templateId, tenant_id: req.tenant.id }).first();
    if (!t) throw notFound('Template');
    if (t.status !== 'APPROVED') throw bad('Template is not approved yet');
    message = buildTemplateMessage(t, b.variables || {}, contactCtx(contact));
  } else if (b.type === 'media') {
    const kind = ['image', 'document', 'video', 'audio'].includes(b.kind) ? b.kind : 'image';
    if (!/^https?:\/\//.test(b.url || '')) throw bad('Provide a public media URL');
    message = { type: kind, [kind]: { link: b.url, ...(b.caption && kind !== 'audio' ? { caption: b.caption } : {}), ...(kind === 'document' ? { filename: b.filename || 'document.pdf' } : {}) } };
  } else if (b.type === 'buttons') {
    const buttons = (b.buttons || []).filter(Boolean).slice(0, 3);
    if (!b.text || !buttons.length) throw bad('Text and 1–3 buttons are required');
    message = { type: 'interactive', interactive: { type: 'button', body: { text: b.text }, action: { buttons: buttons.map((t, i) => ({ type: 'reply', reply: { id: `qr_${i}`, title: String(t).slice(0, 20) } })) } } };
  } else if (b.type === 'product') {
    required(b, ['catalogId', 'retailerId']);
    message = { type: 'interactive', interactive: { type: 'product', body: { text: b.text || 'Check this out' }, action: { catalog_id: b.catalogId, product_retailer_id: b.retailerId } } };
  } else throw bad('Unknown message type');

  const sent = await sendToContact({ tenant: req.tenant, contact, message, numberId: conv.wa_number_id, userId: req.user.id });
  // a human replied: auto-assign to them if unassigned
  if (!conv.assigned_user_id && req.body.autoAssign !== false) {
    await db('conversations').where({ id: conv.id }).update({ assigned_user_id: req.user.id });
    await publish(req.tenant.id, 'conversation.updated', { id: conv.id, assigned_user_id: req.user.id });
  }
  res.status(201).json({ ...sent, sender_name: req.user.name });
}));

r.post('/conversations/:id/notes', h(async (req, res) => {
  const conv = await loadConv(req);
  required(req.body, ['text']);
  const id = await insert('messages', {
    tenant_id: req.tenant.id, conversation_id: conv.id, contact_id: conv.contact_id, direction: 'note', type: 'note',
    content: s({ text: req.body.text }), body: req.body.text, status: 'sent', sender_user_id: req.user.id, created_at: now(),
  });
  const note = { ...serializeMessage(await db('messages').where({ id }).first()), sender_name: req.user.name };
  await publish(req.tenant.id, 'message.note', { message: note, conversation_id: conv.id });
  res.status(201).json(note);
}));

r.patch('/conversations/:id', h(async (req, res) => {
  const conv = await loadConv(req);
  const patch = {};
  if (req.body.status && ['open', 'pending', 'resolved'].includes(req.body.status)) patch.status = req.body.status;
  if (req.body.assigned_user_id !== undefined) {
    if (req.body.assigned_user_id && !(await db('users').where({ id: req.body.assigned_user_id, tenant_id: req.tenant.id }).first())) throw bad('Unknown agent');
    patch.assigned_user_id = req.body.assigned_user_id || null;
  }
  if (req.body.bot_active !== undefined) { patch.bot_active = !!req.body.bot_active; if (!req.body.bot_active) patch.flow_session = null; }
  if (patch.status === 'resolved') { patch.flow_session = null; patch.unread_count = 0; }
  await db('conversations').where({ id: conv.id }).update(patch);
  const fresh = await db('conversations').where({ id: conv.id }).first();
  await publish(req.tenant.id, 'conversation.updated', { ...fresh, flow_session: undefined, bot_active: !!fresh.bot_active });
  res.json(fresh);
}));

r.post('/conversations/:id/read', h(async (req, res) => {
  const conv = await loadConv(req);
  await db('conversations').where({ id: conv.id }).update({ unread_count: 0 });
  res.json({ ok: true });
}));

/** Stream an inbound media file (images, voice notes, documents) through our server. */
r.get('/media/:messageId', h(async (req, res) => {
  const m = await db('messages').where({ id: req.params.messageId, tenant_id: req.tenant.id }).first();
  if (!m) throw notFound('Message');
  const content = j(m.content, {});
  const media = content[m.type];
  if (media?.link) return res.redirect(media.link);
  if (!media?.id) throw notFound('Media');
  const conv = await db('conversations').where({ id: m.conversation_id }).first();
  const number = await getNumber(req.tenant.id, conv.wa_number_id);
  const file = await clientFor(number).downloadMedia(media.id);
  if (!file) throw notFound('Media (mock numbers have no files)');
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(file.buffer);
}));

// ---------- quick replies ----------
r.get('/quick-replies', h(async (req, res) => res.json(await db('quick_replies').where({ tenant_id: req.tenant.id }).orderBy('shortcut'))));
r.post('/quick-replies', h(async (req, res) => {
  required(req.body, ['shortcut', 'body']);
  const id = await insert('quick_replies', { tenant_id: req.tenant.id, shortcut: String(req.body.shortcut).replace(/^\//, ''), body: req.body.body });
  res.status(201).json(await db('quick_replies').where({ id }).first());
}));
r.put('/quick-replies/:id', h(async (req, res) => {
  await db('quick_replies').where({ id: req.params.id, tenant_id: req.tenant.id }).update({ shortcut: String(req.body.shortcut).replace(/^\//, ''), body: req.body.body });
  res.json(await db('quick_replies').where({ id: req.params.id }).first());
}));
r.delete('/quick-replies/:id', h(async (req, res) => {
  await db('quick_replies').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

/**
 * Simulator: inject an inbound message as if a customer wrote on WhatsApp.
 * Only works for numbers in "mock" mode, so it can never fake traffic on a live number.
 */
r.post('/simulate/inbound', h(async (req, res) => {
  const number = req.body.numberId
    ? await db('wa_numbers').where({ id: req.body.numberId, tenant_id: req.tenant.id }).first()
    : await db('wa_numbers').where({ tenant_id: req.tenant.id, mode: 'mock' }).first();
  if (!number || number.mode !== 'mock') throw bad('The simulator works with a demo (mock) number. Add one in Settings → WhatsApp numbers.');
  const from = normalizePhone(req.body.phone || '96550001234');
  if (!from) throw bad('Invalid phone');
  const id = `wamid.SIM${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  let m;
  if (req.body.replyId) {
    const kind = req.body.replyKind === 'list' ? 'list_reply' : 'button_reply';
    m = { from, id, timestamp: String(Math.floor(now() / 1000)), type: 'interactive', interactive: { type: kind, [kind]: { id: req.body.replyId, title: req.body.text || req.body.replyId } } };
  } else {
    m = { from, id, timestamp: String(Math.floor(now() / 1000)), type: 'text', text: { body: String(req.body.text || 'Hi') } };
  }
  await receiveMessage({ tenant: req.tenant, number, message: m, profileName: req.body.name || 'Test Customer' });
  const contact = await db('contacts').where({ tenant_id: req.tenant.id, wa_id: from }).first();
  const conv = await db('conversations').where({ tenant_id: req.tenant.id, contact_id: contact.id }).orderBy('id', 'desc').first();
  res.json({ ok: true, conversation_id: conv.id });
}));

export default r;
