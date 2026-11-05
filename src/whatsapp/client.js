// WhatsApp Cloud API client (Meta Graph API).
// Each tenant number is either "live" (real Cloud API call) or "mock" (simulated, for demos,
// local development and sales trials before the customer has a verified Meta number).
import crypto from 'node:crypto';
import { config } from '../config.js';
import { decrypt, HttpError } from '../lib/util.js';

const base = () => `https://graph.facebook.com/${config.meta.graphVersion}`;

export class WhatsAppError extends HttpError {
  constructor(status, message, meta) {
    super(status >= 500 ? 502 : 400, message, meta);
    this.meta = meta;
  }
}

async function graph(token, method, path, body, query) {
  const url = new URL(base() + path);
  if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    const msg = e.error_data?.details || e.message || `WhatsApp API error (${res.status})`;
    throw new WhatsAppError(res.status, msg, { code: e.code, subcode: e.error_subcode, fbtrace_id: e.fbtrace_id });
  }
  return data;
}

const mockId = () => `wamid.MOCK${crypto.randomBytes(12).toString('hex').toUpperCase()}`;

export function clientFor(number) {
  const token = number.mode === 'live' ? decrypt(number.access_token_enc) : null;
  const isMock = number.mode === 'mock';
  const pid = number.phone_number_id;

  return {
    isMock,

    /** Send any message object (text, template, image, interactive...). Returns wamid. */
    async send(to, message) {
      const payload = { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...message };
      if (isMock) {
        if (String(to).endsWith('0000')) throw new WhatsAppError(400, 'Mock: recipient is not a WhatsApp user', { code: 131026 });
        return mockId();
      }
      const data = await graph(token, 'POST', `/${pid}/messages`, payload);
      return data.messages?.[0]?.id;
    },

    async markRead(wamid) {
      if (isMock || !wamid) return;
      await graph(token, 'POST', `/${pid}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: wamid }).catch(() => {});
    },

    async phoneInfo() {
      if (isMock) return { display_phone_number: number.display_phone || 'Mock number', verified_name: 'Demo Business', quality_rating: 'GREEN' };
      return graph(token, 'GET', `/${pid}`, null, { fields: 'display_phone_number,verified_name,quality_rating,code_verification_status' });
    },

    async listTemplates() {
      if (isMock) return [];
      const out = [];
      let after;
      do {
        const data = await graph(token, 'GET', `/${number.waba_id}/message_templates`, null, {
          limit: 100, after, fields: 'id,name,language,category,status,components,rejected_reason',
        });
        out.push(...(data.data || []));
        after = data.paging?.next ? data.paging?.cursors?.after : null;
      } while (after);
      return out;
    },

    async createTemplate({ name, language, category, components }) {
      if (isMock) return { id: `mock_${Date.now()}`, status: 'APPROVED', category };
      return graph(token, 'POST', `/${number.waba_id}/message_templates`, { name, language, category, components });
    },

    async deleteTemplate(name) {
      if (isMock) return { success: true };
      return graph(token, 'DELETE', `/${number.waba_id}/message_templates`, null, { name });
    },

    /** Resolve an inbound media id to a short-lived URL and download it. */
    async downloadMedia(mediaId) {
      if (isMock) return null;
      const meta = await graph(token, 'GET', `/${mediaId}`);
      const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new WhatsAppError(res.status, 'Media download failed');
      return { mime: meta.mime_type, buffer: Buffer.from(await res.arrayBuffer()) };
    },
  };
}

/** Exchange an Embedded Signup code for a business token (Tech Provider onboarding). */
export async function exchangeSignupCode(code) {
  const url = new URL(`${base()}/oauth/access_token`);
  url.searchParams.set('client_id', config.meta.appId);
  url.searchParams.set('client_secret', config.meta.appSecret);
  url.searchParams.set('code', code);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data.error) throw new WhatsAppError(400, data.error?.message || 'Code exchange failed');
  return data.access_token;
}

export async function registerNumber(token, phoneNumberId, pin) {
  return graph(token, 'POST', `/${phoneNumberId}/register`, { messaging_product: 'whatsapp', pin });
}

export async function subscribeApp(token, wabaId) {
  return graph(token, 'POST', `/${wabaId}/subscribed_apps`);
}
