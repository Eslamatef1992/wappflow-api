import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { HttpError, forbidden, sha256 } from './util.js';

export function signToken(user, extra = {}) {
  return jwt.sign({ sub: user.id, tid: user.tenant_id ?? null, role: user.role, ...extra }, config.jwtSecret, {
    expiresIn: extra.imp ? '2h' : '7d',
  });
}

export function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

export const publicUser = (u) =>
  u && { id: u.id, tenant_id: u.tenant_id, name: u.name, email: u.email, role: u.role, is_active: !!u.is_active, last_seen_at: u.last_seen_at };

/** Dashboard auth (JWT). Loads req.user and, for tenant users, req.tenant. */
export async function requireAuth(req, _res, next) {
  try {
    const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) throw new HttpError(401, 'Not signed in');
    let payload;
    try { payload = verifyToken(raw); } catch { throw new HttpError(401, 'Session expired, please sign in again'); }
    const user = await db('users').where({ id: payload.sub }).first();
    if (!user || !user.is_active) throw new HttpError(401, 'Account disabled');
    req.user = user;
    req.impersonatedBy = payload.imp || null;
    if (user.tenant_id) {
      req.tenant = await db('tenants').where({ id: user.tenant_id }).first();
      if (!req.tenant) throw new HttpError(401, 'Workspace not found');
    }
    // cheap presence tracking, at most once a minute
    if (!user.last_seen_at || now() - user.last_seen_at > 60_000) {
      db('users').where({ id: user.id }).update({ last_seen_at: now() }).catch(() => {});
    }
    next();
  } catch (e) { next(e); }
}

export const requireRole = (...roles) => (req, _res, next) =>
  next(roles.includes(req.user?.role) ? undefined : forbidden('Your role cannot do this'));

export const requireSuperadmin = requireRole('superadmin');

/** Tenant routes: must be a tenant user and the workspace must not be suspended. */
export function requireTenant({ allowSuspended = false } = {}) {
  return (req, _res, next) => {
    if (!req.tenant) return next(forbidden('This area is for workspace users'));
    if (!allowSuspended && req.tenant.status === 'suspended') {
      return next(new HttpError(402, 'Workspace suspended. Please pay the outstanding invoice in Billing.'));
    }
    next();
  };
}

/** Public REST API auth: "Authorization: Bearer wsk_..." or "X-API-Key: wsk_...". */
export async function requireApiKey(req, _res, next) {
  try {
    const raw = req.headers['x-api-key'] || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw || !raw.startsWith('wsk_')) throw new HttpError(401, 'Missing API key');
    const key = await db('api_keys').where({ key_hash: sha256(raw) }).first();
    if (!key) throw new HttpError(401, 'Invalid API key');
    const tenant = await db('tenants').where({ id: key.tenant_id }).first();
    if (!tenant || tenant.status === 'suspended') throw new HttpError(402, 'Workspace suspended');
    req.tenant = tenant;
    req.apiKey = key;
    db('api_keys').where({ id: key.id }).update({ last_used_at: now() }).catch(() => {});
    next();
  } catch (e) { next(e); }
}
