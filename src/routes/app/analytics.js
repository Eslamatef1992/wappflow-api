import { Router } from 'express';
import { db, now } from '../../db.js';
import { h } from '../../lib/util.js';

const r = Router();
const DAY = 86_400_000;
const dayKey = (ts) => new Date(+ts).toISOString().slice(0, 10);

r.get('/analytics', h(async (req, res) => {
  const days = Math.min(Math.max(+req.query.days || 30, 7), 90);
  const since = now() - days * DAY;
  const tid = req.tenant.id;
  const count = async (q) => +(await q.count({ c: '*' }).first()).c;

  const msgs = await db('messages').where({ tenant_id: tid }).andWhere('created_at', '>', since).whereIn('direction', ['in', 'out']).select('direction', 'created_at', 'status');
  const series = {};
  for (let i = days - 1; i >= 0; i--) series[dayKey(now() - i * DAY)] = { date: dayKey(now() - i * DAY), in: 0, out: 0 };
  msgs.forEach((m) => { const k = dayKey(m.created_at); if (series[k]) series[k][m.direction] += 1; });

  const out = msgs.filter((m) => m.direction === 'out');
  const delivered = out.filter((m) => ['delivered', 'read'].includes(m.status)).length;
  const read = out.filter((m) => m.status === 'read').length;

  const campaigns = await db('campaigns').where({ tenant_id: tid }).andWhere('created_at', '>', since)
    .sum({ sent: 'sent', delivered: 'delivered', read: 'read_count', replied: 'replied', failed: 'failed' }).first();

  // median first-response time: first agent reply after the first inbound message, per conversation
  const convs = await db('conversations').where({ tenant_id: tid }).andWhere('created_at', '>', since).select('id').limit(300);
  const times = [];
  for (const c of convs) {
    const firstIn = await db('messages').where({ conversation_id: c.id, direction: 'in' }).orderBy('id').first();
    if (!firstIn) continue;
    const reply = await db('messages').where({ conversation_id: c.id, direction: 'out' }).whereNotNull('sender_user_id').andWhere('id', '>', firstIn.id).orderBy('id').first();
    if (reply) times.push(reply.created_at - firstIn.created_at);
  }
  times.sort((a, b) => a - b);

  const orders = await db('orders').where({ tenant_id: tid }).andWhere('created_at', '>', since).whereNot('status', 'canceled').select('total', 'currency');
  const topFlows = await db('flows').where({ tenant_id: tid }).orderBy('runs', 'desc').limit(5).select('id', 'name', 'runs', 'is_active');
  const agents = await db('messages as m').join('users as u', 'u.id', 'm.sender_user_id').where('m.tenant_id', tid).andWhere('m.created_at', '>', since)
    .andWhere('m.direction', 'out').groupBy('u.id', 'u.name').select('u.id', 'u.name').count({ c: '*' }).orderBy('c', 'desc').limit(8);

  res.json({
    days,
    kpis: {
      contacts: await count(db('contacts').where({ tenant_id: tid })),
      newContacts: await count(db('contacts').where({ tenant_id: tid }).andWhere('created_at', '>', since)),
      openConversations: await count(db('conversations').where({ tenant_id: tid, status: 'open' })),
      unassigned: await count(db('conversations').where({ tenant_id: tid, status: 'open' }).whereNull('assigned_user_id')),
      messagesIn: msgs.length - out.length,
      messagesOut: out.length,
      deliveryRate: out.length ? delivered / out.length : 0,
      readRate: out.length ? read / out.length : 0,
      medianFirstResponseMs: times.length ? times[Math.floor(times.length / 2)] : null,
      orders: orders.length,
      revenue: orders.reduce((a, o) => a + +o.total, 0),
      currency: orders[0]?.currency || 'KWD',
    },
    series: Object.values(series),
    campaigns: Object.fromEntries(Object.entries(campaigns || {}).map(([k, v]) => [k, +(v || 0)])),
    topFlows: topFlows.map((f) => ({ ...f, is_active: !!f.is_active })),
    agents: agents.map((a) => ({ ...a, c: +a.c })),
  });
}));

export default r;
