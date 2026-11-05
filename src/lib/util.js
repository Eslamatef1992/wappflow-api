import crypto from 'node:crypto';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const bad = (msg, details) => new HttpError(400, msg, details);
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);

/** Wrap async route handlers so thrown errors reach the error middleware. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function required(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw bad(`Missing fields: ${missing.join(', ')}`);
}

// ---- encryption for stored secrets (WhatsApp access tokens, integration secrets) ----
const key = crypto.createHash('sha256').update(config.appKey).digest();

export function encrypt(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload) {
  if (!payload) return null;
  const [iv, tag, enc] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function hmacHex(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('hex');
}
export function hmacB64(secret, raw) {
  return crypto.createHmac('sha256', secret).update(raw).digest('base64');
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Normalize a phone number to WhatsApp wa_id format (digits only, with country code). */
export function normalizePhone(input, defaultCountry = '965') {
  if (!input) return null;
  let d = String(input).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.length === 8 && defaultCountry) d = defaultCountry + d; // local Kuwaiti number
  d = d.replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export const slugify = (v) =>
  String(v).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';

export function paginate(req, max = 100) {
  const limit = Math.min(Math.max(+(req.query.limit || 25), 1), max);
  const page = Math.max(+(req.query.page || 1), 1);
  return { limit, page, offset: (page - 1) * limit };
}

/** Replace {{path.to.value}} placeholders with values from ctx. */
export function render(text, ctx) {
  if (!text) return '';
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p) => {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    return v == null ? '' : String(v);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
