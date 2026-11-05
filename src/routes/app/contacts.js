import { Router } from 'express';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { db, j, s, now, insert } from '../../db.js';
import { h, bad, notFound, required, paginate, normalizePhone } from '../../lib/util.js';
import { assertLimit } from '../../services/billing.js';
import { serializeContact } from '../../services/commerce.js';
import { publish } from '../../lib/events.js';

const r = Router();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

async function withTags(contacts) {
  if (!contacts.length) return [];
  const rows = await db('contact_tags as ct').join('tags as t', 't.id', 'ct.tag_id')
    .whereIn('ct.contact_id', contacts.map((c) => c.id)).select('ct.contact_id', 't.id', 't.name', 't.color');
  return contacts.map((c) => ({ ...serializeContact(c), tags: rows.filter((x) => x.contact_id === c.id).map(({ contact_id, ...t }) => t) }));
}

async function setTags(tenantId, contactId, tagIds) {
  const valid = await db('tags').where({ tenant_id: tenantId }).whereIn('id', tagIds.map(Number)).select('id');
  await db('contact_tags').where({ contact_id: contactId }).del();
  if (valid.length) await db('contact_tags').insert(valid.map((t) => ({ contact_id: contactId, tag_id: t.id })));
}

r.get('/contacts', h(async (req, res) => {
  const { limit, offset } = paginate(req, 200);
  const q = db('contacts').where({ tenant_id: req.tenant.id });
  if (req.query.q) {
    const term = `%${req.query.q}%`;
    q.where((w) => w.where('name', 'like', term).orWhere('wa_id', 'like', term).orWhere('email', 'like', term));
  }
  if (req.query.tag) q.whereIn('id', db('contact_tags').where({ tag_id: +req.query.tag }).select('contact_id'));
  if (req.query.opted === 'out') q.where({ opted_in: false });
  const total = +(await q.clone().count({ c: '*' }).first()).c;
  const rows = await q.orderBy('id', 'desc').limit(limit).offset(offset);
  res.json({ total, data: await withTags(rows) });
}));

r.get('/contacts/export', h(async (req, res) => {
  const rows = await withTags(await db('contacts').where({ tenant_id: req.tenant.id }).orderBy('id'));
  const keys = [...new Set(rows.flatMap((c) => Object.keys(c.attributes || {})))];
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const lines = [['phone', 'name', 'email', 'opted_in', 'tags', ...keys].map(esc).join(',')];
  rows.forEach((c) => lines.push([`+${c.wa_id}`, c.name, c.email, c.opted_in ? 'yes' : 'no', c.tags.map((t) => t.name).join('|'), ...keys.map((k) => c.attributes[k])].map(esc).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
  res.send('﻿' + lines.join('\n'));
}));

r.get('/contacts/:id', h(async (req, res) => {
  const c = await db('contacts').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!c) throw notFound('Contact');
  const [contact] = await withTags([c]);
  const orders = await db('orders').where({ contact_id: c.id }).orderBy('id', 'desc').limit(10);
  res.json({ ...contact, orders });
}));

r.post('/contacts', h(async (req, res) => {
  required(req.body, ['phone']);
  const wa_id = normalizePhone(req.body.phone);
  if (!wa_id) throw bad('Invalid phone number. Use international format, e.g. +96550000000');
  if (await db('contacts').where({ tenant_id: req.tenant.id, wa_id }).first()) throw bad('This contact already exists');
  await assertLimit(req.tenant, 'contacts', 1);
  const id = await insert('contacts', {
    tenant_id: req.tenant.id, wa_id, name: req.body.name || null, email: req.body.email || null,
    attributes: s(req.body.attributes || {}), opted_in: req.body.opted_in !== false, source: 'manual', created_at: now(),
  });
  if (req.body.tagIds?.length) await setTags(req.tenant.id, id, req.body.tagIds);
  const [contact] = await withTags([await db('contacts').where({ id }).first()]);
  await publish(req.tenant.id, 'contact.created', { contact });
  res.status(201).json(contact);
}));

r.patch('/contacts/:id', h(async (req, res) => {
  const c = await db('contacts').where({ id: req.params.id, tenant_id: req.tenant.id }).first();
  if (!c) throw notFound('Contact');
  const patch = {};
  ['name', 'email'].forEach((k) => { if (req.body[k] !== undefined) patch[k] = req.body[k] || null; });
  if (req.body.attributes) patch.attributes = s(req.body.attributes);
  if (req.body.opted_in !== undefined) { patch.opted_in = !!req.body.opted_in; patch.opted_out_at = req.body.opted_in ? null : now(); }
  if (Object.keys(patch).length) await db('contacts').where({ id: c.id }).update(patch);
  if (Array.isArray(req.body.tagIds)) await setTags(req.tenant.id, c.id, req.body.tagIds);
  const [contact] = await withTags([await db('contacts').where({ id: c.id }).first()]);
  res.json(contact);
}));

r.delete('/contacts/:id', h(async (req, res) => {
  await db('contacts').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

r.post('/contacts/bulk', h(async (req, res) => {
  const ids = (req.body.contactIds || []).map(Number);
  const owned = (await db('contacts').where({ tenant_id: req.tenant.id }).whereIn('id', ids).select('id')).map((c) => c.id);
  if (req.body.action === 'delete') await db('contacts').whereIn('id', owned).del();
  if (req.body.action === 'tag' || req.body.action === 'untag') {
    const tag = await db('tags').where({ id: req.body.tagId, tenant_id: req.tenant.id }).first();
    if (!tag) throw notFound('Tag');
    await db('contact_tags').where({ tag_id: tag.id }).whereIn('contact_id', owned).del();
    if (req.body.action === 'tag' && owned.length) await db('contact_tags').insert(owned.map((id) => ({ contact_id: id, tag_id: tag.id })));
  }
  res.json({ ok: true, affected: owned.length });
}));

/**
 * CSV import. Recognised columns: phone (required), name, email, tags (separated by | or ;).
 * Every other column becomes a custom attribute usable in templates and flows.
 */
r.post('/contacts/import', upload.single('file'), h(async (req, res) => {
  if (!req.file) throw bad('Upload a CSV file');
  let rows;
  try {
    rows = parse(req.file.buffer.toString('utf8').replace(/^﻿/, ''), { columns: (h) => h.map((x) => String(x).trim().toLowerCase()), skip_empty_lines: true, trim: true });
  } catch (e) { throw bad(`Could not read CSV: ${e.message}`); }
  const phoneKey = ['phone', 'mobile', 'whatsapp', 'number', 'رقم'].find((k) => rows[0] && k in rows[0]);
  if (!phoneKey) throw bad('CSV needs a "phone" column');
  const extraTagIds = (req.body.tagIds ? String(req.body.tagIds).split(',') : []).map(Number).filter(Boolean);

  const existing = new Set((await db('contacts').where({ tenant_id: req.tenant.id }).select('wa_id')).map((c) => c.wa_id));
  const fresh = new Set(rows.map((r) => normalizePhone(r[phoneKey])).filter((p) => p && !existing.has(p)));
  await assertLimit(req.tenant, 'contacts', fresh.size);

  const tagCache = new Map((await db('tags').where({ tenant_id: req.tenant.id })).map((t) => [t.name.toLowerCase(), t.id]));
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };

  for (const [i, row] of rows.entries()) {
    const wa_id = normalizePhone(row[phoneKey]);
    if (!wa_id) { result.skipped++; if (result.errors.length < 20) result.errors.push(`Row ${i + 2}: invalid phone "${row[phoneKey]}"`); continue; }
    const { [phoneKey]: _p, name, email, tags, ...attrs } = row;
    const attributes = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== ''));
    let c = await db('contacts').where({ tenant_id: req.tenant.id, wa_id }).first();
    if (c) {
      await db('contacts').where({ id: c.id }).update({ name: name || c.name, email: email || c.email, attributes: s({ ...j(c.attributes, {}), ...attributes }) });
      result.updated++;
    } else {
      c = { id: await insert('contacts', { tenant_id: req.tenant.id, wa_id, name: name || null, email: email || null, attributes: s(attributes), opted_in: true, source: 'import', created_at: now() }) };
      result.created++;
    }
    const tagIds = [...extraTagIds];
    for (const tname of String(tags || '').split(/[|;]/).map((x) => x.trim()).filter(Boolean)) {
      const key = tname.toLowerCase();
      if (!tagCache.has(key)) tagCache.set(key, await insert('tags', { tenant_id: req.tenant.id, name: tname }));
      tagIds.push(tagCache.get(key));
    }
    for (const tid of new Set(tagIds)) {
      if (!(await db('contact_tags').where({ contact_id: c.id, tag_id: tid }).first())) await db('contact_tags').insert({ contact_id: c.id, tag_id: tid });
    }
  }
  res.json(result);
}));

// ---------- tags ----------
r.get('/tags', h(async (req, res) => {
  const tags = await db('tags').where({ tenant_id: req.tenant.id }).orderBy('name');
  const counts = await db('contact_tags').whereIn('tag_id', tags.map((t) => t.id)).groupBy('tag_id').select('tag_id').count({ c: '*' });
  res.json(tags.map((t) => ({ ...t, contacts: +(counts.find((c) => c.tag_id === t.id)?.c || 0) })));
}));
r.post('/tags', h(async (req, res) => {
  required(req.body, ['name']);
  if (await db('tags').where({ tenant_id: req.tenant.id, name: req.body.name }).first()) throw bad('Tag already exists');
  const id = await insert('tags', { tenant_id: req.tenant.id, name: req.body.name, color: req.body.color || '#16a34a' });
  res.status(201).json(await db('tags').where({ id }).first());
}));
r.patch('/tags/:id', h(async (req, res) => {
  await db('tags').where({ id: req.params.id, tenant_id: req.tenant.id }).update({ ...(req.body.name ? { name: req.body.name } : {}), ...(req.body.color ? { color: req.body.color } : {}) });
  res.json(await db('tags').where({ id: req.params.id }).first());
}));
r.delete('/tags/:id', h(async (req, res) => {
  await db('tags').where({ id: req.params.id, tenant_id: req.tenant.id }).del();
  res.json({ ok: true });
}));

export default r;
