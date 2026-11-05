import { Router } from 'express';
import { db, j, s, now, insert } from '../../db.js';
import { h, bad, notFound, required } from '../../lib/util.js';
import { getNumber } from '../../services/messaging.js';
import { clientFor } from '../../whatsapp/client.js';

const r = Router();

const serialize = (t) => t && { ...t, components: j(t.components, []) };

/** Ensure Meta-required example values exist for every {{n}} variable. */
function withExamples(components) {
  return components.map((c) => {
    const vars = (c.text?.match(/\{\{\d+\}\}/g) || []).length;
    if (c.type === 'BODY' && vars && !c.example?.body_text) {
      return { ...c, example: { body_text: [Array.from({ length: vars }, (_, i) => c.examples?.[i] || `value${i + 1}`)] } };
    }
    if (c.type === 'HEADER' && c.format === 'TEXT' && vars && !c.example?.header_text) {
      return { ...c, example: { header_text: [c.examples?.[0] || 'value'] } };
    }
    const { examples, ...rest } = c;
    return rest;
  }).map(({ examples, ...c }) => c);
}

r.get('/templates', h(async (req, res) => {
  const q = db('templates').where({ tenant_id: req.tenant.id });
  if (req.query.status) q.where({ status: req.query.status });
  res.json((await q.orderBy('updated_at', 'desc')).map(serialize));
}));

r.get('/templates/:id', h(async (req, res) => {
  const t = await db('templates').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!t) throw notFound('Template');
  res.json(serialize(t));
}));

/** Submit a new template to Meta for approval (mock numbers approve instantly). */
r.post('/templates', h(async (req, res) => {
  required(req.body, ['name', 'language', 'category', 'components']);
  const name = String(req.body.name).toLowerCase().trim().replace(/[^a-z0-9_]+/g, '_');
  if (!/^[a-z0-9_]{1,512}$/.test(name)) throw bad('Name may use lowercase letters, numbers and underscores');
  if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(req.body.category)) throw bad('Invalid category');
  const components = withExamples(req.body.components || []);
  if (!components.some((c) => c.type === 'BODY' && c.text)) throw bad('Body text is required');
  if (await db('templates').where({ tenant_id: req.tenant.id, name, language: req.body.language }).first()) throw bad('A template with this name and language already exists');

  const number = await getNumber(req.tenant.id, req.body.numberId);
  const result = await clientFor(number).createTemplate({ name, language: req.body.language, category: req.body.category, components });
  const id = await insert('templates', {
    tenant_id: req.tenant.id, wa_number_id: number.id, meta_id: result.id, name, language: req.body.language,
    category: result.category || req.body.category, status: result.status || 'PENDING', components: s(components),
    created_at: now(), updated_at: now(),
  });
  res.status(201).json(serialize(await db('templates').where({ id }).first()));
}));

/** Pull every template (and its latest approval status) from Meta for all connected WABAs. */
r.post('/templates/sync', h(async (req, res) => {
  const numbers = await db('wa_numbers').where({ tenant_id: req.tenant.id, mode: 'live' });
  const seen = new Set();
  let synced = 0;
  for (const n of numbers) {
    if (!n.waba_id || seen.has(n.waba_id)) continue;
    seen.add(n.waba_id);
    for (const t of await clientFor(n).listTemplates()) {
      const row = {
        tenant_id: req.tenant.id, wa_number_id: n.id, meta_id: t.id, name: t.name, language: t.language, category: t.category,
        status: t.status, components: s(t.components || []), rejected_reason: t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null, updated_at: now(),
      };
      const existing = await db('templates').where({ tenant_id: req.tenant.id, name: t.name, language: t.language }).first();
      if (existing) await db('templates').where({ id: existing.id }).update(row);
      else await insert('templates', { ...row, created_at: now() });
      synced++;
    }
  }
  res.json({ synced, wabas: seen.size });
}));

r.delete('/templates/:id', h(async (req, res) => {
  const t = await db('templates').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!t) throw notFound('Template');
  const number = t.wa_number_id ? await db('wa_numbers').where({ id: t.wa_number_id }).first() : null;
  if (number && req.query.local !== '1') await clientFor(number).deleteTemplate(t.name);
  await db('templates').where({ id: t.id }).del();
  res.json({ ok: true });
}));

export default r;
