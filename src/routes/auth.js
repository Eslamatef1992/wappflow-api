import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { db, now, insert } from '../db.js';
import { h, bad, required, slugify, HttpError } from '../lib/util.js';
import { signToken, publicUser, requireAuth } from '../lib/auth.js';
import { queueEmail } from '../services/email.js';
import { startTrial, planFor, usageFor, serializePlan, tapEnabled, isPreview } from '../services/billing.js';
import { paypalEnabled } from '../services/paypal.js';

const r = Router();

r.get('/config', h(async (_req, res) => {
  const plans = await db('plans').where({ is_active: true }).orderBy('sort');
  res.json({ brand: config.brand, allowSignup: config.allowSignup, trialDays: config.trialDays, onlinePayments: tapEnabled() || paypalEnabled(), plans: plans.map(serializePlan), metaAppId: config.meta.appId || null, embeddedSignupConfigId: config.meta.embeddedSignupConfigId || null });
}));

r.post('/signup', h(async (req, res) => {
  if (!config.allowSignup) throw bad('Sign-ups are closed. Contact us to get an account.');
  required(req.body, ['company', 'name', 'email', 'password']);
  const email = String(req.body.email).toLowerCase().trim();
  if (String(req.body.password).length < 8) throw bad('Password must be at least 8 characters');
  if (await db('users').where({ email }).first()) throw bad('An account with this email already exists');

  const plan = (req.body.planId && (await db('plans').where({ id: req.body.planId, is_active: true }).first()))
    || (await db('plans').where({ is_active: true }).orderBy('sort').first());
  if (!plan) throw bad('No plans configured yet');

  let slug = slugify(req.body.company);
  if (await db('tenants').where({ slug }).first()) slug = `${slug}-${Date.now().toString(36)}`;

  const user = await db.transaction(async (trx) => {
    const tenantId = await insert('tenants', { name: req.body.company, slug, status: 'trial', plan_id: plan.id, created_at: now() }, trx);
    await startTrial(tenantId, plan.id, trx);
    const userId = await insert('users', {
      tenant_id: tenantId, name: req.body.name, email, role: 'owner', is_active: true,
      password_hash: await bcrypt.hash(req.body.password, 10), created_at: now(),
    }, trx);
    return trx('users').where({ id: userId }).first();
  });
  await queueEmail('welcome', { tenantId: user.tenant_id });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

r.post('/login', h(async (req, res) => {
  required(req.body, ['email', 'password']);
  const user = await db('users').where({ email: String(req.body.email).toLowerCase().trim() }).first();
  if (!user || !(await bcrypt.compare(String(req.body.password), user.password_hash))) throw new HttpError(401, 'Wrong email or password');
  if (!user.is_active) throw new HttpError(403, 'This account is disabled');
  res.json({ token: signToken(user), user: publicUser(user) });
}));

r.get('/me', requireAuth, h(async (req, res) => {
  const out = { user: publicUser(req.user), impersonatedBy: req.impersonatedBy };
  if (req.tenant) {
    const plan = await planFor(req.tenant);
    const sub = await db('subscriptions').where({ tenant_id: req.tenant.id }).orderBy('id', 'desc').first();
    out.tenant = req.tenant;
    out.preview = isPreview(req.tenant); // not paid yet: explore only, nothing real is connected or sent
    out.plan = plan.id ? serializePlan(plan) : null;
    out.subscription = sub || null;
    out.usage = await usageFor(req.tenant.id);
    // 'live' | 'demo' | 'none': demo numbers only simulate sending, so the dashboard warns about it
    const numbers = await db('wa_numbers').where({ tenant_id: req.tenant.id }).select('mode');
    out.whatsapp = numbers.some((n) => n.mode === 'live') ? 'live' : numbers.length ? 'demo' : 'none';
  }
  res.json(out);
}));

r.post('/change-password', requireAuth, h(async (req, res) => {
  required(req.body, ['current', 'password']);
  if (!(await bcrypt.compare(String(req.body.current), req.user.password_hash))) throw bad('Current password is wrong');
  if (String(req.body.password).length < 8) throw bad('Password must be at least 8 characters');
  await db('users').where({ id: req.user.id }).update({ password_hash: await bcrypt.hash(req.body.password, 10) });
  res.json({ ok: true });
}));

r.patch('/profile', requireAuth, h(async (req, res) => {
  if (req.body.name) await db('users').where({ id: req.user.id }).update({ name: String(req.body.name).slice(0, 120) });
  res.json({ user: publicUser(await db('users').where({ id: req.user.id }).first()) });
}));

export default r;
