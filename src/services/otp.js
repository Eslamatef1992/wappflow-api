// WhatsApp OTP: a workspace's app calls the API to send a one-time code to a phone, then to check it.
// Each code sent uses one prepaid credit; a failed send gives the credit back.
// Codes are stored only as a hash and are masked in the inbox.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { db, j, s, now, insert } from '../db.js';
import { HttpError, bad, normalizePhone } from '../lib/util.js';
import { sendToContact } from './messaging.js';
import { upsertContact } from './commerce.js';

export const OTP_EVENT = 'otp.code';
const SEND_COOLDOWN_MS = 30_000; // one code per phone every 30 seconds
const MAX_PER_HOUR = 5; // per phone
const MAX_ATTEMPTS = 5; // wrong guesses before the code is blocked

const hash = (tenantId, phone, code) => crypto.createHmac('sha256', config.appKey || config.jwtSecret).update(`${tenantId}:${phone}:${code}`).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const maskPhone = (wa) => { const p = String(wa || ''); return p.length > 6 ? `+${p.slice(0, 3)}${'•'.repeat(p.length - 6)}${p.slice(-3)}` : (p ? `+${p}` : ''); };

// ---------------------------------------------------------------- credits
/** Add (or remove, with a negative delta) credits and record it. Returns the new balance. */
export async function addCredits(tenantId, delta, { reason, ref = null, userId = null } = {}) {
  return db.transaction(async (trx) => {
    if (delta < 0) {
      const ok = await trx('tenants').where({ id: tenantId }).andWhere('otp_credits', '>=', -delta).decrement('otp_credits', -delta);
      if (!ok) throw new HttpError(402, 'Not enough OTP credits');
    } else {
      await trx('tenants').where({ id: tenantId }).increment('otp_credits', delta);
    }
    const { otp_credits: balance } = await trx('tenants').where({ id: tenantId }).first('otp_credits');
    await insert('credit_ledger', { tenant_id: tenantId, delta, balance_after: balance, reason, ref, user_id: userId, created_at: now() }, trx);
    return balance;
  });
}

export const creditBalance = async (tenantId) => +(await db('tenants').where({ id: tenantId }).first('otp_credits'))?.otp_credits || 0;

// ---------------------------------------------------------------- template
/** Meta's ready-made authentication template: "<code> is your verification code." + a Copy code button. */
export function otpTemplate(lang = 'en', expiryMinutes = 10) {
  const ar = lang === 'ar';
  return {
    name: 'otp_code', language: ar ? 'ar' : 'en', category: 'AUTHENTICATION',
    // what Meta receives (the body text of authentication templates is written by Meta)
    meta: [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: expiryMinutes },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: ar ? 'نسخ الرمز' : 'Copy code' }] },
    ],
    // what we keep, so the dashboard can show a preview
    stored: [
      {
        type: 'BODY', add_security_recommendation: true,
        text: ar ? '{{1}} هو رمز التحقق الخاص بك. لأمانك، لا تشارك هذا الرمز.' : '{{1}} is your verification code. For your security, do not share this code.',
      },
      { type: 'FOOTER', code_expiration_minutes: expiryMinutes, text: ar ? `تنتهي صلاحية هذا الرمز خلال ${expiryMinutes} دقائق.` : `This code expires in ${expiryMinutes} minutes.` },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: ar ? 'نسخ الرمز' : 'Copy code' }] },
    ],
  };
}

/** The template message carrying the code (body {{1}} + the copy-code button). */
export function otpMessage(template, code) {
  const comps = j(template.components, []);
  const hasButton = comps.some((c) => c.type === 'BUTTONS' && (c.buttons || []).some((b) => b.type === 'OTP' || b.type === 'URL'));
  return {
    type: 'template',
    template: {
      name: template.name, language: { code: template.language },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        ...(hasButton ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }] : []),
      ],
    },
    _preview: `${'•'.repeat(code.length)} is your verification code.`,
  };
}

async function otpSetup(tenantId, language) {
  const a = await db('automations').where({ tenant_id: tenantId, event: OTP_EVENT, is_active: true }).first();
  const q = db('templates').where({ tenant_id: tenantId, status: 'APPROVED' });
  if (a) {
    const chosen = await q.clone().where({ id: a.template_id }).first();
    if (chosen && (!language || chosen.language === language)) return { template: chosen, numberId: a.wa_number_id };
    // a template with the same name in the requested language
    if (chosen && language) {
      const other = await q.clone().where({ name: chosen.name, language }).first();
      if (other) return { template: other, numberId: a.wa_number_id };
    }
  }
  const fallback = await q.clone().where({ category: 'AUTHENTICATION', ...(language ? { language } : {}) }).orderBy('id').first();
  return { template: fallback || null, numberId: a?.wa_number_id || null };
}

// ---------------------------------------------------------------- send / verify
export async function sendOtp(tenant, body = {}) {
  const phone = normalizePhone(body.phone || body.to);
  if (!phone) throw bad('A valid "phone" with country code is required');
  const length = Math.min(Math.max(+body.length || 6, 4), 8);
  const expiry = Math.min(Math.max(+body.expiry_minutes || 10, 1), 60);
  const code = body.code != null ? String(body.code) : String(crypto.randomInt(0, 10 ** length)).padStart(length, '0');
  if (!/^\d{4,10}$/.test(code)) throw bad('"code" must be 4 to 10 digits');

  const { template, numberId } = await otpSetup(tenant.id, body.language);
  if (!template) throw bad('No approved OTP template yet. Set one up in OTP → Setup (it is usually approved within minutes).');

  const t = now();
  const recent = await db('otp_codes').where({ tenant_id: tenant.id, phone }).andWhere('created_at', '>', t - 3600_000).orderBy('id', 'desc');
  if (recent[0] && t - recent[0].created_at < SEND_COOLDOWN_MS) {
    throw new HttpError(429, `Please wait ${Math.ceil((SEND_COOLDOWN_MS - (t - recent[0].created_at)) / 1000)} seconds before sending another code to this number`);
  }
  if (recent.length >= MAX_PER_HOUR) throw new HttpError(429, 'Too many codes sent to this number. Try again in an hour.');

  // one credit per code (402 when the balance is empty)
  await addCredits(tenant.id, -1, { reason: 'otp', ref: phone });

  // older codes for this number stop working once a new one is sent
  await db('otp_codes').where({ tenant_id: tenant.id, phone, status: 'pending' }).update({ status: 'expired' });
  const id = await insert('otp_codes', {
    tenant_id: tenant.id, phone, code_hash: hash(tenant.id, phone, code), status: 'pending', attempts: 0,
    reference: body.reference ? String(body.reference).slice(0, 120) : null, expires_at: t + expiry * 60_000, created_at: t,
  });

  const contact = await upsertContact(tenant.id, { phone, name: body.name, source: 'otp' });
  try {
    const msg = await sendToContact({ tenant, contact, numberId: body.numberId || numberId, message: otpMessage(template, code) });
    // keep the code out of the inbox and the message history
    await db('messages').where({ id: msg.id }).update({ content: s({ type: 'template', template: { name: template.name, language: { code: template.language }, otp: true } }) });
    await db('otp_codes').where({ id }).update({ message_id: msg.id });
    return { id, phone, status: 'sent', expires_at: t + expiry * 60_000, credits_left: await creditBalance(tenant.id) };
  } catch (e) {
    await db('otp_codes').where({ id }).update({ status: 'failed', error: String(e.message).slice(0, 500), message_id: e.messageRecord?.id || null });
    if (e.messageRecord?.id) await db('messages').where({ id: e.messageRecord.id }).update({ content: s({ type: 'template', template: { name: template.name, otp: true } }) });
    await addCredits(tenant.id, 1, { reason: 'refund', ref: phone });
    throw e;
  }
}

/** Check a code. Returns { valid: true } or { valid: false, reason }. */
export async function verifyOtp(tenant, body = {}) {
  const phone = normalizePhone(body.phone || body.to);
  const code = String(body.code ?? '').trim();
  if (!phone || !code) throw bad('"phone" and "code" are required');
  const otp = await db('otp_codes').where({ tenant_id: tenant.id, phone }).whereIn('status', ['pending', 'verified', 'blocked']).orderBy('id', 'desc').first();
  if (!otp) return { valid: false, reason: 'not_found' };
  if (otp.status === 'verified') return { valid: false, reason: 'already_used' };
  if (otp.status === 'blocked') return { valid: false, reason: 'too_many_attempts' };
  if (otp.expires_at < now()) {
    await db('otp_codes').where({ id: otp.id }).update({ status: 'expired' });
    return { valid: false, reason: 'expired' };
  }
  if (sameHash(otp.code_hash, hash(tenant.id, phone, code))) {
    await db('otp_codes').where({ id: otp.id, status: 'pending' }).update({ status: 'verified', verified_at: now(), attempts: otp.attempts + 1 });
    return { valid: true, id: otp.id, reference: otp.reference || null };
  }
  const attempts = otp.attempts + 1;
  await db('otp_codes').where({ id: otp.id }).update({ attempts, ...(attempts >= MAX_ATTEMPTS ? { status: 'blocked' } : {}) });
  return { valid: false, reason: attempts >= MAX_ATTEMPTS ? 'too_many_attempts' : 'invalid_code', attempts_left: Math.max(MAX_ATTEMPTS - attempts, 0) };
}

export const serializeOtp = (o) => o && ({
  id: o.id, phone: maskPhone(o.phone), status: o.status, attempts: o.attempts, reference: o.reference,
  error: o.error, expires_at: o.expires_at, verified_at: o.verified_at, created_at: o.created_at,
});
