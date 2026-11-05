import { Router } from 'express';
import { db, j, s, now, insert } from '../../db.js';
import { h, bad, notFound, required } from '../../lib/util.js';
import { assertFeature, assertLimit } from '../../services/billing.js';
import { validateGraph } from '../../services/flows.js';

const r = Router();
r.use('/flows', h(async (req, _res, next) => { await assertFeature(req.tenant, 'flows'); next(); }));

const serialize = (f) => f && { ...f, graph: j(f.graph, { nodes: [], edges: [] }), is_active: !!f.is_active };

const starterGraph = () => ({
  nodes: [
    { id: 'start', type: 'start', position: { x: 80, y: 160 }, data: { label: 'Start' } },
    { id: 'welcome', type: 'buttons', position: { x: 380, y: 120 }, data: { label: 'Welcome', text: 'Hi {{contact.first_name}} 👋 How can we help you today?', buttons: [{ id: 'b1', title: 'Our products' }, { id: 'b2', title: 'Order status' }, { id: 'b3', title: 'Talk to us' }] } },
    { id: 'agent', type: 'assign', position: { x: 760, y: 280 }, data: { label: 'Hand over', text: 'Connecting you with our team, one moment please.' } },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'welcome' },
    { id: 'e2', source: 'welcome', sourceHandle: 'b3', target: 'agent' },
  ],
});

r.get('/flows', h(async (req, res) => {
  res.json((await db('flows').where({ tenant_id: req.tenant.id }).orderBy('id', 'desc')).map((f) => ({ ...serialize(f), graph: undefined, nodes: j(f.graph, { nodes: [] }).nodes.length })));
}));

r.get('/flows/:id', h(async (req, res) => {
  const f = await db('flows').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!f) throw notFound('Flow');
  res.json(serialize(f));
}));

r.post('/flows', h(async (req, res) => {
  required(req.body, ['name']);
  const id = await insert('flows', {
    tenant_id: req.tenant.id, name: req.body.name, trigger_type: req.body.trigger_type || 'keyword',
    trigger_value: req.body.trigger_value || 'hi,hello,مرحبا,السلام عليكم', graph: s(req.body.graph || starterGraph()),
    is_active: false, created_at: now(), updated_at: now(),
  });
  res.status(201).json(serialize(await db('flows').where({ id }).first()));
}));

r.put('/flows/:id', h(async (req, res) => {
  const f = await db('flows').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!f) throw notFound('Flow');
  const patch = { updated_at: now() };
  ['name', 'trigger_type', 'trigger_value'].forEach((k) => { if (req.body[k] !== undefined) patch[k] = req.body[k]; });
  if (req.body.graph) {
    patch.graph = s(req.body.graph);
    if (f.is_active) {
      const problems = validateGraph(req.body.graph);
      if (problems.length) throw bad(`Fix before saving an active flow: ${problems.join('; ')}`, problems);
    }
  }
  await db('flows').where({ id: f.id }).update(patch);
  res.json(serialize(await db('flows').where({ id: f.id }).first()));
}));

r.post('/flows/:id/toggle', h(async (req, res) => {
  const f = await db('flows').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!f) throw notFound('Flow');
  const active = req.body.active ?? !f.is_active;
  if (active) {
    const problems = validateGraph(j(f.graph));
    if (problems.length) throw bad(problems.join('; '), problems);
    if (!f.is_active) await assertLimit(req.tenant, 'flows', 1);
    if (f.trigger_type !== 'keyword') {
      const clash = await db('flows').where({ tenant_id: req.tenant.id, trigger_type: f.trigger_type, is_active: true }).whereNot({ id: f.id }).first();
      if (clash) throw bad(`"${clash.name}" already uses this trigger. Turn it off first.`);
    }
  }
  await db('flows').where({ id: f.id }).update({ is_active: !!active });
  res.json(serialize(await db('flows').where({ id: f.id }).first()));
}));

r.post('/flows/:id/duplicate', h(async (req, res) => {
  const f = await db('flows').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!f) throw notFound('Flow');
  const id = await insert('flows', { tenant_id: req.tenant.id, name: `${f.name} (copy)`, trigger_type: f.trigger_type, trigger_value: f.trigger_value, graph: f.graph, is_active: false, created_at: now(), updated_at: now() });
  res.status(201).json(serialize(await db('flows').where({ id }).first()));
}));

r.delete('/flows/:id', h(async (req, res) => {
  await db('flows').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

export default r;
