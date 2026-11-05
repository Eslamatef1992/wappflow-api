// Account emails to workspace owners through Mailgun's HTTP API:
//   welcome  — a workspace was created
//   invoice  — an invoice was issued (new plan or renewal)
//   receipt  — an invoice was paid and the plan is active
// Emails go through the job queue, so a Mailgun hiccup never breaks signup or payment (5 retries).
import { config } from '../config.js';
import { db, j } from '../db.js';
import { enqueue, registerJob } from '../lib/jobs.js';

export const mailEnabled = () => !!(config.mailgun.apiKey && config.mailgun.domain);

const apiBase = () => config.mailgun.apiBase || (config.mailgun.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net');

/** Send one email now. Throws on failure (the job queue retries). */
export async function sendEmail({ to, subject, html, text, replyTo }) {
  if (!mailEnabled()) return { skipped: true };
  const form = new URLSearchParams({ from: config.mailgun.from, to, subject, html, text });
  if (replyTo || config.mailgun.replyTo) form.set('h:Reply-To', replyTo || config.mailgun.replyTo);
  const res = await fetch(`${apiBase()}/v3/${config.mailgun.domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`api:${config.mailgun.apiKey}`).toString('base64')}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Mailgun ${res.status}: ${body.slice(0, 300)}`);
  try { return JSON.parse(body); } catch { return { ok: true }; }
}

/** Queue an account email. kind: welcome | invoice | receipt. Never throws. */
export async function queueEmail(kind, data, { delayMs = 0 } = {}) {
  if (!mailEnabled()) return;
  try { await enqueue('email.send', { kind, ...data }, { delayMs }); } catch (e) { console.warn('[email] could not queue', e.message); }
}

// ---------------------------------------------------------------- content
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur) => `${(+n || 0).toFixed(['KWD', 'BHD', 'OMR', 'JOD'].includes(cur) ? 3 : 2)} ${cur}`;
const day = (ts, lang) => (ts ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-KW-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(+ts)) : '');
const site = () => config.siteUrls[0] || config.appUrl;

function layout({ preheader, en, ar }) {
  const block = (c, lang) => `
    <tr><td dir="${lang === 'ar' ? 'rtl' : 'ltr'}" style="padding:28px 32px ${lang === 'ar' ? '32px' : '8px'};text-align:${lang === 'ar' ? 'right' : 'left'};font-family:${lang === 'ar' ? "Tahoma,'Segoe UI'," : ''}-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#14201a">
      <h1 style="margin:0 0 12px;font-size:20px;line-height:1.35">${c.title}</h1>
      ${c.paras.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#3b4a42">${p}</p>`).join('')}
      ${c.rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 16px;border-collapse:collapse">${c.rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #e3e8e5;font-size:14px;color:#6b7a72">${k}</td><td dir="${/[\u0600-\u06FF]/.test(v) ? 'rtl' : 'ltr'}" style="padding:8px 0;border-bottom:1px solid #e3e8e5;font-size:14px;font-weight:600;text-align:${lang === 'ar' ? 'left' : 'right'}">${v}</td></tr>`).join('')}</table>` : ''}
      ${c.button ? `<a href="${esc(c.button.url)}" style="display:inline-block;margin:6px 0 4px;background:#0f8a4f;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:8px">${c.button.label}</a>` : ''}
    </td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#eef1ee">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1ee;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
    <tr><td style="padding:22px 32px;border-bottom:1px solid #e3e8e5"><img src="${esc(site())}/brand/wappflow-logo.png" alt="${esc(config.brand)}" height="30" style="display:block;height:30px;border:0"></td></tr>
    ${block(en, 'en')}
    <tr><td style="padding:0 32px"><div style="border-top:1px dashed #d5ddd8"></div></td></tr>
    ${block(ar, 'ar')}
  </table>
  <p style="font-family:Arial,sans-serif;font-size:12px;color:#7d8a83;margin:16px 0 0">${esc(config.brand)} · <a href="${esc(site())}" style="color:#7d8a83">${esc(site().replace(/^https?:\/\//, ''))}</a></p>
</td></tr></table></body></html>`;
}

const plain = (en, ar) => [en, ar].map((c) => [c.title, ...c.paras.map((p) => p.replace(/<[^>]+>/g, '')), ...(c.rows || []).map(([k, v]) => `${k}: ${v}`), c.button ? `${c.button.label}: ${c.button.url}` : ''].join('\n')).join('\n\n----\n\n');

export function buildEmail(kind, { tenant, owner, invoice, plan, sub }) {
  const name = esc((owner.name || '').split(' ')[0] || owner.name || '');
  const billing = `${config.appUrl}/app/billing`;
  const brand = esc(config.brand);
  let en; let ar; let subject; let preheader;

  if (kind === 'welcome') {
    subject = `Welcome to ${config.brand}, ${tenant.name}`;
    preheader = 'Your workspace is ready.';
    en = {
      title: `Welcome to ${brand}, ${name}`,
      paras: [
        `Your workspace <b>${esc(tenant.name)}</b> is ready. You can explore every feature right away with a demo number: the shared inbox, chatbots, campaigns and invoices.`,
        'When you are ready to connect your own WhatsApp number and send real messages, choose a plan and pay by Visa, Mastercard or PayPal.',
      ],
      button: { label: 'Open your dashboard', url: `${config.appUrl}/app` },
    };
    ar = {
      title: `أهلاً بك في ${brand}، ${name}`,
      paras: [
        `مساحة عملك <b>${esc(tenant.name)}</b> جاهزة. يمكنك تجربة كل المزايا فوراً برقم تجريبي: صندوق الوارد المشترك، وروبوتات المحادثة، والحملات، والفواتير.`,
        'عندما تكون جاهزاً لربط رقم واتساب الخاص بك وإرسال رسائل حقيقية، اختر باقة وادفع بفيزا أو ماستركارد أو PayPal.',
      ],
      button: { label: 'افتح لوحة التحكم', url: `${config.appUrl}/app?lang=ar` },
    };
  } else if (kind === 'invoice') {
    const amount = money(invoice.amount, invoice.currency);
    subject = `Invoice ${invoice.number} · ${amount}`;
    preheader = `Your ${plan?.name || ''} plan invoice is ready to pay.`;
    en = {
      title: `Invoice ${esc(invoice.number)}`,
      paras: [`Hi ${name}, here is the invoice for <b>${esc(tenant.name)}</b>. Pay it online to activate or continue your plan.`],
      rows: [['Plan', esc(invoice.notes || plan?.name || '')], ['Amount', amount], ['Due', day(invoice.due_at, 'en')]],
      button: { label: 'Pay now', url: billing },
    };
    ar = {
      title: `فاتورة ${esc(invoice.number)}`,
      paras: [`مرحباً ${name}، هذه فاتورة <b>${esc(tenant.name)}</b>. ادفعها إلكترونياً لتفعيل باقتك أو استمرارها.`],
      rows: [['الباقة', esc(plan?.name || invoice.notes || '')], ['المبلغ', amount], ['تاريخ الاستحقاق', day(invoice.due_at, 'ar')]],
      button: { label: 'ادفع الآن', url: `${billing}?lang=ar` },
    };
  } else if (kind === 'receipt') {
    const amount = money(invoice.amount, invoice.currency);
    subject = `Payment received · ${invoice.number}`;
    preheader = `Thank you. Your ${plan?.name || ''} plan is active.`;
    const via = invoice.provider === 'paypal' ? 'PayPal' : invoice.provider === 'tap' ? 'card' : invoice.provider || '';
    en = {
      title: 'Payment received. Thank you!',
      paras: [`Hi ${name}, we received your payment for <b>${esc(tenant.name)}</b>. Your plan is active${sub?.current_period_end ? ` until <b>${day(sub.current_period_end, 'en')}</b>` : ''}.`],
      rows: [['Invoice', esc(invoice.number)], ['Plan', esc(plan?.name || invoice.notes || '')], ['Amount paid', amount], ...(via ? [['Paid with', esc(via)]] : []), ['Date', day(invoice.paid_at, 'en')]],
      button: { label: 'Open your dashboard', url: `${config.appUrl}/app` },
    };
    ar = {
      title: 'تم استلام الدفع. شكراً لك!',
      paras: [`مرحباً ${name}، استلمنا دفعتك لـ <b>${esc(tenant.name)}</b>. باقتك مفعّلة${sub?.current_period_end ? ` حتى <b>${day(sub.current_period_end, 'ar')}</b>` : ''}.`],
      rows: [['الفاتورة', esc(invoice.number)], ['الباقة', esc(plan?.name || invoice.notes || '')], ['المبلغ المدفوع', amount], ...(via ? [['طريقة الدفع', esc(via)]] : []), ['التاريخ', day(invoice.paid_at, 'ar')]],
      button: { label: 'افتح لوحة التحكم', url: `${config.appUrl}/app?lang=ar` },
    };
  } else {
    throw new Error(`Unknown email kind ${kind}`);
  }
  return { subject, html: layout({ preheader, en, ar }), text: plain(en, ar) };
}

registerJob('email.send', async (p) => {
  const tenant = await db('tenants').where({ id: p.tenantId }).first();
  if (!tenant) return; // workspace deleted meanwhile
  const owner = await db('users').where({ tenant_id: tenant.id, role: 'owner' }).first();
  if (!owner?.email) return;
  const invoice = p.invoiceId ? await db('invoices').where({ id: p.invoiceId }).first() : null;
  if (p.kind !== 'welcome' && !invoice) return;
  if (p.kind === 'invoice' && invoice.status !== 'unpaid') return; // paid or replaced before we got to it
  const plan = invoice?.plan_id ? await db('plans').where({ id: invoice.plan_id }).first() : await db('plans').where({ id: tenant.plan_id }).first();
  const sub = await db('subscriptions').where({ tenant_id: tenant.id }).orderBy('id', 'desc').first();
  const mail = buildEmail(p.kind, { tenant, owner, invoice, plan: plan && { ...plan, limits: j(plan.limits, {}) }, sub });
  await sendEmail({ to: owner.name ? `${owner.name.replace(/[<>",]/g, '')} <${owner.email}>` : owner.email, ...mail });
});
