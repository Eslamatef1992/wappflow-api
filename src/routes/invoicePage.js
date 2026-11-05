// Public invoice page: the link a customer opens from the WhatsApp message (/i/<token>).
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, j } from '../db.js';
import { config } from '../config.js';

const r = Router();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dp = (cur) => (['KWD', 'BHD', 'OMR', 'JOD'].includes(cur) ? 3 : 2);
const amount = (n, cur) => `<bdi dir="ltr">${(+n || 0).toFixed(dp(cur))} ${esc(cur)}</bdi>`;

const T = {
  en: {
    invoice: 'Invoice', billedTo: 'Billed to', date: 'Date', due: 'Due', item: 'Item', qty: 'Qty', price: 'Price', total: 'Total',
    pay: 'Pay now', pdf: 'Download PDF', print: 'Print', paid: 'Paid', unpaid: 'Unpaid', void: 'Canceled', notes: 'Notes',
    notFound: 'This invoice link is not valid.', other: 'العربية', subtotal: 'Amount',
  },
  ar: {
    invoice: 'فاتورة', billedTo: 'إلى', date: 'التاريخ', due: 'تاريخ الاستحقاق', item: 'الصنف', qty: 'الكمية', price: 'السعر', total: 'الإجمالي',
    pay: 'ادفع الآن', pdf: 'تحميل PDF', print: 'طباعة', paid: 'مدفوعة', unpaid: 'غير مدفوعة', void: 'ملغاة', notes: 'ملاحظات',
    notFound: 'رابط الفاتورة غير صالح.', other: 'English', subtotal: 'المبلغ',
  },
};

function page(lang, title, body) {
  const ar = lang === 'ar';
  return `<!doctype html>
<html lang="${lang}" dir="${ar ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Arabic:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root { --paper:#fff; --desk:#eef1ee; --ink:#14201a; --ink2:#4b5a52; --ink3:#7d8a83; --line:#dfe5e1; --green:#0f8a4f; --green-wash:#e3f4ea; --amber:#9a5b06; --amber-wash:#fdf1dc; --red:#a3312a; --red-wash:#fbe7e5; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--desk); color:var(--ink); font:15px/1.55 ${ar ? "'IBM Plex Sans Arabic'," : ''}'IBM Plex Sans',system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:640px; margin:0 auto; padding:28px 16px 48px; }
  .bar { display:flex; justify-content:flex-end; margin-bottom:12px; font-size:13px; }
  .bar a { color:var(--ink2); }
  .sheet { background:var(--paper); border-radius:10px; box-shadow:0 1px 0 var(--line), 0 18px 40px -24px rgba(20,32,26,.35); overflow:hidden; }
  .head { padding:28px 28px 22px; border-bottom:1px dashed var(--line); display:flex; gap:16px; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; }
  .biz { font-size:22px; font-weight:600; letter-spacing:-.01em; margin:0 0 4px; }
  .num { font-family:'IBM Plex Mono',monospace; color:var(--ink2); font-size:14px; }
  .stamp { font-weight:600; font-size:13px; padding:4px 12px; border-radius:999px; white-space:nowrap; }
  .stamp.paid { color:var(--green); background:var(--green-wash); }
  .stamp.unpaid { color:var(--amber); background:var(--amber-wash); }
  .stamp.void { color:var(--red); background:var(--red-wash); }
  .meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px 24px; padding:20px 28px; }
  .meta dt { color:var(--ink3); font-size:12px; }
  .meta dd { margin:2px 0 0; font-weight:500; }
  table { width:100%; border-collapse:collapse; }
  th { text-align:start; font-size:12px; color:var(--ink3); font-weight:500; padding:10px 28px 8px; border-bottom:1px solid var(--line); }
  td { padding:12px 28px; border-bottom:1px solid var(--line); vertical-align:top; }
  td.n, th.n { text-align:end; font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.q, th.q { text-align:center; width:56px; padding-inline:8px; }
  .total { display:flex; justify-content:space-between; align-items:baseline; padding:22px 28px; }
  .total span { color:var(--ink2); }
  .total strong { font-size:28px; font-weight:600; letter-spacing:-.02em; font-variant-numeric:tabular-nums; }
  .notes { padding:0 28px 22px; color:var(--ink2); font-size:14px; white-space:pre-line; }
  .actions { display:flex; gap:10px; flex-wrap:wrap; padding:0 28px 28px; }
  .btn { display:inline-flex; align-items:center; justify-content:center; min-height:46px; padding:0 22px; border-radius:8px; font:inherit; font-weight:600; text-decoration:none; border:1px solid var(--line); color:var(--ink); background:#fff; cursor:pointer; }
  .btn.primary { background:var(--green); border-color:var(--green); color:#fff; flex:1 1 200px; }
  .btn:focus-visible { outline:3px solid #8fd3ad; outline-offset:2px; }
  .foot { text-align:center; color:var(--ink3); font-size:12px; margin-top:18px; }
  .empty { padding:48px 28px; text-align:center; color:var(--ink2); }
  @media (max-width:480px) { .head, .meta, .total, .notes, .actions { padding-inline:18px; } th, td { padding-inline:18px; } }
  @media print { body { background:#fff; } .bar, .actions, .foot { display:none; } .sheet { box-shadow:none; } }
</style>
</head>
<body><div class="wrap">${body}</div></body></html>`;
}

r.get('/i/:token', rateLimit({ windowMs: 60_000, limit: 120 }), async (req, res, next) => {
  try {
    const inv = /^[\w-]{8,64}$/.test(req.params.token) && await db('sales_invoices').where({ token: req.params.token }).first();
    const accept = String(req.headers['accept-language'] || '');
    const lang = req.query.lang === 'ar' || req.query.lang === 'en' ? req.query.lang : (/^ar\b/i.test(accept) ? 'ar' : 'en');
    const t = T[lang];
    res.set('Cache-Control', 'no-store').set('X-Robots-Tag', 'noindex').type('html');
    if (!inv) return res.status(404).send(page(lang, t.notFound, `<div class="sheet"><p class="empty">${t.notFound}</p></div>`));

    const tenant = await db('tenants').where({ id: inv.tenant_id }).first();
    const contact = inv.contact_id && await db('contacts').where({ id: inv.contact_id }).first();
    const items = j(inv.items, []);
    const fmtDate = (d) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar-KW-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
    const status = ['paid', 'unpaid', 'void'].includes(inv.status) ? inv.status : 'unpaid';
    const other = lang === 'ar' ? 'en' : 'ar';

    const rows = items.map((it) => `<tr><td>${esc(it.name)}</td><td class="q">${esc(it.quantity)}</td><td class="n">${amount(it.price * it.quantity, inv.currency)}</td></tr>`).join('');
    const body = `
<div class="bar"><a href="?lang=${other}" lang="${other}">${t.other}</a></div>
<article class="sheet">
  <header class="head">
    <div><h1 class="biz">${esc(tenant?.name || config.brand)}</h1><div class="num">${t.invoice} ${esc(inv.number)}</div></div>
    <span class="stamp ${status}">${t[status]}</span>
  </header>
  <dl class="meta">
    ${contact?.name || contact?.wa_id ? `<div><dt>${t.billedTo}</dt><dd>${esc(contact.name || `+${contact.wa_id}`)}</dd></div>` : ''}
    <div><dt>${t.date}</dt><dd>${fmtDate(new Date(+inv.created_at))}</dd></div>
    ${inv.due_date ? `<div><dt>${t.due}</dt><dd>${fmtDate(new Date(`${inv.due_date}T12:00:00Z`))}</dd></div>` : ''}
  </dl>
  ${items.length ? `<table><thead><tr><th>${t.item}</th><th class="q">${t.qty}</th><th class="n">${t.subtotal}</th></tr></thead><tbody>${rows}</tbody></table>` : ''}
  <div class="total"><span>${t.total}</span><strong dir="ltr">${amount(inv.total, inv.currency)}</strong></div>
  ${inv.notes ? `<div class="notes">${esc(inv.notes)}</div>` : ''}
  <div class="actions">
    ${inv.pay_url && status === 'unpaid' ? `<a class="btn primary" href="${esc(inv.pay_url)}" rel="noopener">${t.pay}</a>` : ''}
    ${inv.pdf_url ? `<a class="btn" href="${esc(inv.pdf_url)}" rel="noopener">${t.pdf}</a>` : ''}
    <button class="btn" type="button" onclick="window.print()">${t.print}</button>
  </div>
</article>
<p class="foot">${esc(tenant?.name || '')} · ${esc(config.brand)}</p>`;
    res.send(page(lang, `${t.invoice} ${inv.number} · ${tenant?.name || config.brand}`, body));
  } catch (e) { next(e); }
});

export default r;
