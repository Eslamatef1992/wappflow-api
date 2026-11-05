import { Router } from 'express';
import { db, s, now, insert } from '../../db.js';
import { h, bad, notFound, required, paginate } from '../../lib/util.js';
import { enqueue } from '../../lib/jobs.js';
import { publish } from '../../lib/events.js';
import { assertFeature } from '../../services/billing.js';
import { countAudience, launchCampaign, serializeCampaign } from '../../services/campaigns.js';

const r = Router();
r.use('/campaigns', h(async (req, _res, next) => { await assertFeature(req.tenant, 'campaigns'); next(); }));

async function load(req) {
  const c = await db('campaigns').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!c) throw notFound('Campaign');
  return c;
}

r.post('/campaigns/audience-count', h(async (req, res) => {
  res.json({ count: await countAudience(req.tenant.id, req.body.audience || {}) });
}));

r.get('/campaigns', h(async (req, res) => {
  const rows = await db('campaigns as c').leftJoin('templates as t', 't.id', 'c.template_id')
    .where('c.tenant_id', req.tenant.id).select('c.*', 't.name as template_name').orderBy('c.id', 'desc');
  res.json(rows.map(serializeCampaign));
}));

r.get('/campaigns/:id', h(async (req, res) => {
  const c = await load(req);
  const template = c.template_id ? await db('templates').where({ id: c.template_id }).first() : null;
  res.json({ ...serializeCampaign(c), template_name: template?.name, template_language: template?.language });
}));

r.get('/campaigns/:id/recipients', h(async (req, res) => {
  const c = await load(req);
  const { limit, offset } = paginate(req, 200);
  const q = db('campaign_recipients as r').join('contacts as ct', 'ct.id', 'r.contact_id').where('r.campaign_id', c.id);
  if (req.query.status) q.where('r.status', req.query.status);
  const total = +(await q.clone().count({ c: 'r.id' }).first()).c;
  res.json({ total, data: await q.select('r.*', 'ct.name', 'ct.wa_id').orderBy('r.id').limit(limit).offset(offset) });
}));

function payload(b) {
  return {
    name: b.name, template_id: b.templateId || null, wa_number_id: b.numberId || null,
    audience: s(b.audience || { all: false, tagIds: [] }), variables: s(b.variables || {}),
    scheduled_at: b.scheduledAt ? +new Date(b.scheduledAt) : null,
  };
}

r.post('/campaigns', h(async (req, res) => {
  required(req.body, ['name']);
  const id = await insert('campaigns', { tenant_id: req.tenant.id, ...payload(req.body), status: 'draft', created_by: req.user.id, created_at: now() });
  res.status(201).json(serializeCampaign(await db('campaigns').where({ id }).first()));
}));

r.put('/campaigns/:id', h(async (req, res) => {
  const c = await load(req);
  if (!['draft', 'scheduled'].includes(c.status)) throw bad('Only drafts can be edited');
  await db('campaigns').where({ id: c.id }).update({ ...payload({ ...req.body, name: req.body.name || c.name }), status: 'draft' });
  res.json(serializeCampaign(await db('campaigns').where({ id: c.id }).first()));
}));

/** Launch now, or schedule when scheduledAt is in the future. */
r.post('/campaigns/:id/launch', h(async (req, res) => {
  const c = await load(req);
  const when = req.body.scheduledAt ? +new Date(req.body.scheduledAt) : c.scheduled_at;
  if (when && when > now() + 30_000) {
    if (c.status !== 'draft') throw bad('Only drafts can be scheduled');
    const t = await db('templates').where({ id: c.template_id, tenant_id: req.tenant.id }).first();
    if (!t || t.status !== 'APPROVED') throw bad('Choose an approved template');
    await db('campaigns').where({ id: c.id }).update({ status: 'scheduled', scheduled_at: when });
    await enqueue('campaign.start', { campaignId: c.id }, { runAt: when });
  } else {
    await launchCampaign(req.tenant, c);
  }
  res.json(serializeCampaign(await db('campaigns').where({ id: c.id }).first()));
}));

r.post('/campaigns/:id/pause', h(async (req, res) => {
  const c = await load(req);
  if (c.status !== 'running') throw bad('Campaign is not running');
  await db('campaigns').where({ id: c.id }).update({ status: 'paused' });
  await publish(req.tenant.id, 'campaign.updated', { id: c.id, status: 'paused' });
  res.json(serializeCampaign(await db('campaigns').where({ id: c.id }).first()));
}));

r.post('/campaigns/:id/resume', h(async (req, res) => {
  const c = await load(req);
  if (c.status !== 'paused') throw bad('Campaign is not paused');
  await launchCampaign(req.tenant, c);
  res.json(serializeCampaign(await db('campaigns').where({ id: c.id }).first()));
}));

r.post('/campaigns/:id/cancel', h(async (req, res) => {
  const c = await load(req);
  if (['completed', 'canceled'].includes(c.status)) throw bad(`Campaign already ${c.status}`);
  await db('campaigns').where({ id: c.id }).update({ status: 'canceled', completed_at: now() });
  await db('campaign_recipients').where({ campaign_id: c.id, status: 'pending' }).update({ status: 'failed', error: 'Canceled' });
  res.json(serializeCampaign(await db('campaigns').where({ id: c.id }).first()));
}));

r.post('/campaigns/:id/duplicate', h(async (req, res) => {
  const c = await load(req);
  const id = await insert('campaigns', {
    tenant_id: req.tenant.id, name: `${c.name} (copy)`, template_id: c.template_id, wa_number_id: c.wa_number_id,
    audience: c.audience, variables: c.variables, status: 'draft', created_by: req.user.id, created_at: now(),
  });
  res.status(201).json(serializeCampaign(await db('campaigns').where({ id }).first()));
}));

r.delete('/campaigns/:id', h(async (req, res) => {
  const c = await load(req);
  if (c.status === 'running') throw bad('Pause or cancel the campaign first');
  await db('campaigns').where({ id: c.id }).del();
  res.json({ ok: true });
}));

export default r;
