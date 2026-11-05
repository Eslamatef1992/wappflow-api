// Chatbot flow engine. Flows are graphs drawn in the visual builder (React Flow format):
//   nodes: [{ id, type, data }], edges: [{ source, sourceHandle, target }]
// Node types: start, message, media, buttons, list, question, condition, tag, attribute,
//             assign, webhook, delay, end
import { db, j, s, now, insert } from '../db.js';
import { render } from '../lib/util.js';
import { publish } from '../lib/events.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { sendToContact, contactCtx } from './messaging.js';

const MAX_STEPS = 40;

function nextNode(graph, nodeId, handle) {
  const edge = graph.edges.find((e) =>
    e.source === nodeId && ((handle && e.sourceHandle === handle) || (!handle && (!e.sourceHandle || e.sourceHandle === 'out'))));
  return edge ? graph.nodes.find((n) => n.id === edge.target) : null;
}

const norm = (v) => String(v || '').trim().toLowerCase();

function matchesKeywords(flow, text) {
  const t = norm(text);
  if (!t) return false;
  return String(flow.trigger_value || '').split(',').map(norm).filter(Boolean)
    .some((k) => t === k || t.split(/\s+/).includes(k));
}

/** Text of an inbound message used for matching (typed text, button title or reply id). */
export function inboundText(message) {
  if (message.type === 'text') return message.text?.body;
  if (message.type === 'button') return message.button?.text;
  if (message.type === 'interactive') {
    const i = message.interactive;
    return i?.button_reply?.title || i?.list_reply?.title;
  }
  return '';
}
function inboundReplyId(message) {
  const i = message.interactive;
  return i?.button_reply?.id || i?.list_reply?.id || message.button?.payload || null;
}

async function saveSession(convId, session) {
  await db('conversations').where({ id: convId }).update({ flow_session: session ? s(session) : null });
}

async function loadCtx(tenantId, contactId, session) {
  const contact = await db('contacts').where({ id: contactId, tenant_id: tenantId }).first();
  return { contact, ctx: contactCtx(contact, { vars: session.vars || {} }) };
}

function evalCondition(data, ctx) {
  const left = render(`{{${data.field || 'vars.last_reply'}}}`, ctx);
  const right = render(data.value ?? '', ctx);
  const l = norm(left);
  const r = norm(right);
  switch (data.operator) {
    case 'equals': return l === r;
    case 'not_equals': return l !== r;
    case 'contains': return l.includes(r);
    case 'starts_with': return l.startsWith(r);
    case 'is_set': return l !== '';
    case 'is_not_set': return l === '';
    case 'gt': return +left > +right;
    case 'lt': return +left < +right;
    default: return false;
  }
}

/** Execute nodes starting at `node` until the flow waits for input, delays, or ends. */
async function run({ tenant, conv, flow, graph, node, session }) {
  let steps = 0;
  while (node && steps++ < MAX_STEPS) {
    const d = node.data || {};
    const { contact, ctx } = await loadCtx(tenant.id, conv.contact_id, session);
    const send = (message) => sendToContact({ tenant, contact, message, numberId: conv.wa_number_id, flowId: flow.id });
    let handle;

    switch (node.type) {
      case 'start':
        break;
      case 'message':
        if (d.text) await send({ type: 'text', text: { body: render(d.text, ctx), preview_url: true } });
        break;
      case 'media': {
        const kind = d.mediaType || 'image';
        if (d.url) await send({ type: kind, [kind]: { link: d.url, ...(d.caption && kind !== 'audio' ? { caption: render(d.caption, ctx) } : {}), ...(kind === 'document' && d.filename ? { filename: d.filename } : {}) } });
        break;
      }
      case 'buttons': {
        const buttons = (d.buttons || []).slice(0, 3);
        await send({
          type: 'interactive',
          interactive: {
            type: 'button',
            ...(d.header ? { header: { type: 'text', text: render(d.header, ctx).slice(0, 60) } } : {}),
            body: { text: render(d.text || 'Choose an option', ctx).slice(0, 1024) },
            ...(d.footer ? { footer: { text: d.footer.slice(0, 60) } } : {}),
            action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: `${node.id}::${b.id}`, title: String(b.title).slice(0, 20) } })) },
          },
        });
        await saveSession(conv.id, { ...session, flowId: flow.id, nodeId: node.id, waiting: true });
        return;
      }
      case 'list': {
        const rows = (d.rows || []).slice(0, 10);
        await send({
          type: 'interactive',
          interactive: {
            type: 'list',
            body: { text: render(d.text || 'Choose an option', ctx).slice(0, 4096) },
            ...(d.footer ? { footer: { text: d.footer.slice(0, 60) } } : {}),
            action: {
              button: String(d.buttonText || 'Options').slice(0, 20),
              sections: [{ title: String(d.sectionTitle || 'Options').slice(0, 24), rows: rows.map((r) => ({ id: `${node.id}::${r.id}`, title: String(r.title).slice(0, 24), ...(r.description ? { description: String(r.description).slice(0, 72) } : {}) })) }],
            },
          },
        });
        await saveSession(conv.id, { ...session, flowId: flow.id, nodeId: node.id, waiting: true });
        return;
      }
      case 'question':
        await send({ type: 'text', text: { body: render(d.text || '', ctx) } });
        await saveSession(conv.id, { ...session, flowId: flow.id, nodeId: node.id, waiting: true });
        return;
      case 'condition':
        handle = evalCondition(d, ctx) ? 'true' : 'false';
        break;
      case 'tag': {
        if (d.tag) {
          let tag = await db('tags').where({ tenant_id: tenant.id, name: d.tag }).first();
          if (!tag) tag = { id: await insert('tags', { tenant_id: tenant.id, name: d.tag }) };
          const exists = await db('contact_tags').where({ contact_id: contact.id, tag_id: tag.id }).first();
          if (d.action === 'remove') await db('contact_tags').where({ contact_id: contact.id, tag_id: tag.id }).del();
          else if (!exists) await db('contact_tags').insert({ contact_id: contact.id, tag_id: tag.id });
        }
        break;
      }
      case 'attribute': {
        if (d.key) {
          const attrs = j(contact.attributes, {});
          attrs[d.key] = render(d.value ?? '', ctx);
          await db('contacts').where({ id: contact.id }).update({ attributes: s(attrs) });
        }
        break;
      }
      case 'assign': {
        if (d.text) await send({ type: 'text', text: { body: render(d.text, ctx) } });
        let userId = d.userId ? +d.userId : null;
        if (!userId && d.strategy !== 'unassigned') userId = await leastBusyAgent(tenant.id);
        await db('conversations').where({ id: conv.id }).update({ bot_active: false, assigned_user_id: userId, status: 'open', flow_session: null });
        await publish(tenant.id, 'conversation.updated', { id: conv.id, assigned_user_id: userId, bot_active: false });
        return;
      }
      case 'webhook': {
        try {
          const res = await fetch(d.url, {
            method: d.method || 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: d.method === 'GET' ? undefined : JSON.stringify({ contact: ctx.contact, vars: session.vars, conversation_id: conv.id }),
            signal: AbortSignal.timeout(8000),
          });
          const data = await res.json().catch(() => ({}));
          session.vars = { ...session.vars, webhook: data };
          handle = res.ok ? 'success' : 'error';
        } catch {
          handle = 'error';
        }
        if (!nextNode(graph, node.id, handle)) handle = undefined;
        break;
      }
      case 'delay': {
        const ms = Math.max(1, +d.seconds || 60) * 1000;
        const after = nextNode(graph, node.id);
        if (after) {
          await saveSession(conv.id, { ...session, flowId: flow.id, nodeId: after.id, waiting: false, delayed: true });
          await enqueue('flow.resume', { tenantId: tenant.id, conversationId: conv.id, nodeId: after.id }, { delayMs: ms });
        } else await saveSession(conv.id, null);
        return;
      }
      case 'end':
        if (d.text) await send({ type: 'text', text: { body: render(d.text, ctx) } });
        await saveSession(conv.id, null);
        return;
      default:
        break;
    }
    node = nextNode(graph, node.id, handle);
  }
  await saveSession(conv.id, null);
}

async function leastBusyAgent(tenantId) {
  const agents = await db('users').where({ tenant_id: tenantId, is_active: true }).whereIn('role', ['agent', 'admin', 'owner']).select('id');
  if (!agents.length) return null;
  const loads = await db('conversations').where({ tenant_id: tenantId, status: 'open' }).whereNotNull('assigned_user_id')
    .groupBy('assigned_user_id').select('assigned_user_id').count({ c: '*' });
  const map = Object.fromEntries(loads.map((l) => [l.assigned_user_id, +l.c]));
  return agents.sort((a, b) => (map[a.id] || 0) - (map[b.id] || 0))[0].id;
}

/** Called for every inbound message. Returns true if a flow handled it. */
export async function handleInbound({ tenant, conv, message, isNewContact }) {
  conv = await db('conversations').where({ id: conv.id }).first();
  if (!conv.bot_active) return false;
  const text = inboundText(message);
  let session = j(conv.flow_session);

  const flows = await db('flows').where({ tenant_id: tenant.id, is_active: true });
  const keywordFlow = flows.find((f) => f.trigger_type === 'keyword' && matchesKeywords(f, text));

  // 1) continue a flow that is waiting for this contact's reply (a new keyword restarts instead)
  if (session?.waiting && !keywordFlow) {
    const flow = flows.find((f) => f.id === session.flowId);
    const graph = flow && j(flow.graph, { nodes: [], edges: [] });
    const node = graph?.nodes.find((n) => n.id === session.nodeId);
    if (!node) { await saveSession(conv.id, null); return false; }
    session.vars = { ...(session.vars || {}), last_reply: text };

    if (node.type === 'question') {
      if (node.data?.saveTo) {
        const contact = await db('contacts').where({ id: conv.contact_id }).first();
        if (node.data.saveTo === 'name') await db('contacts').where({ id: contact.id }).update({ name: text });
        else if (node.data.saveTo === 'email') await db('contacts').where({ id: contact.id }).update({ email: text });
        else {
          const attrs = j(contact.attributes, {});
          attrs[node.data.saveTo] = text;
          await db('contacts').where({ id: contact.id }).update({ attributes: s(attrs) });
        }
      }
      session.vars[node.data?.variable || 'answer'] = text;
      session.waiting = false;
      await run({ tenant, conv, flow, graph, node: nextNode(graph, node.id), session });
      return true;
    }

    // buttons / list: match by reply id, then by typed title
    const options = node.type === 'buttons' ? node.data?.buttons || [] : node.data?.rows || [];
    const replyId = inboundReplyId(message);
    const chosen = options.find((o) => replyId === `${node.id}::${o.id}`) || options.find((o) => norm(o.title) === norm(text));
    if (chosen) {
      session.vars.choice = chosen.title;
      session.waiting = false;
      await run({ tenant, conv, flow, graph, node: nextNode(graph, node.id, chosen.id), session });
      return true;
    }
    // unrecognised answer: re-ask once, then let a human take over
    if ((session.retries || 0) < 1) {
      await run({ tenant, conv, flow, graph, node, session: { ...session, retries: (session.retries || 0) + 1 } });
      return true;
    }
    await saveSession(conv.id, null);
    return false;
  }

  // 2) start a new flow
  const flow = keywordFlow
    || (isNewContact && flows.find((f) => f.trigger_type === 'new_contact'))
    || (!session && flows.find((f) => f.trigger_type === 'any_message'));
  if (!flow) return false;
  const graph = j(flow.graph, { nodes: [], edges: [] });
  const start = graph.nodes.find((n) => n.type === 'start');
  if (!start) return false;
  await db('flows').where({ id: flow.id }).increment('runs', 1);
  session = { flowId: flow.id, vars: { last_reply: text }, startedAt: now() };
  await run({ tenant, conv, flow, graph, node: start, session });
  return true;
}

registerJob('flow.resume', async ({ tenantId, conversationId, nodeId }) => {
  const conv = await db('conversations').where({ id: conversationId }).first();
  const session = j(conv?.flow_session);
  if (!conv || !conv.bot_active || !session?.delayed || session.nodeId !== nodeId) return;
  const tenant = await db('tenants').where({ id: tenantId }).first();
  const flow = await db('flows').where({ id: session.flowId, is_active: true }).first();
  if (!flow || tenant.status === 'suspended') return saveSession(conv.id, null);
  const graph = j(flow.graph, { nodes: [], edges: [] });
  await run({ tenant, conv, flow, graph, node: graph.nodes.find((n) => n.id === nodeId), session: { ...session, delayed: false } });
});

/** Validate a graph before saving/activating. Returns a list of problems. */
export function validateGraph(graph) {
  const problems = [];
  const nodes = graph?.nodes || [];
  if (!nodes.some((n) => n.type === 'start')) problems.push('Add a Start node');
  for (const n of nodes) {
    const d = n.data || {};
    if (n.type === 'buttons' && (!d.buttons?.length || d.buttons.length > 3)) problems.push(`"${d.label || n.id}": buttons need 1–3 options`);
    if (n.type === 'list' && (!d.rows?.length || d.rows.length > 10)) problems.push(`"${d.label || n.id}": lists need 1–10 rows`);
    if (n.type === 'webhook' && !/^https?:\/\//.test(d.url || '')) problems.push(`"${d.label || n.id}": webhook URL is missing`);
    if (['message', 'question'].includes(n.type) && !d.text) problems.push(`"${d.label || n.id}": text is empty`);
  }
  return problems;
}
