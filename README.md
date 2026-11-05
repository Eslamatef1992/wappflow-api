# WappFlow Backend — WhatsApp Business Platform API

> Backend of the WappFlow platform. The dashboard (customer app + super-admin panel) lives in **[wappflow-admin](https://github.com/Eslamatef1992/wappflow-admin)**.

A complete platform you can sell to businesses on a monthly plan: each customer gets their own workspace
with a shared WhatsApp team inbox, broadcast campaigns, a visual chatbot builder, store/order automations
and an API — and you get a super-admin panel to manage workspaces, plans, invoices and platform health.

Built on the **official WhatsApp Cloud API** (Meta Graph API), so customers' numbers are never at risk of bans
the way unofficial "WhatsApp Web" bridges are.

```
wappflow-api/   Node.js 20+ · Express · Knex (SQLite / MySQL / MariaDB / PostgreSQL) · Socket.IO  ← this repo
├── src/         API, WhatsApp Cloud API client, job queue, services
├── test/        end-to-end tests
└── deploy/      PM2 + Nginx configs
wappflow-admin/     React 19 · Vite · Tailwind 4 · React Flow · Recharts  ← dashboard repo
```

---

## What's inside

**For your customers (workspace app, `/app`)**

| Area | What it does |
|---|---|
| Team inbox | Real-time chat, agent assignment (manual + least-busy auto), internal notes, quick replies with `/shortcut`, open/pending/resolved, **24-hour window meter** that blocks free text once WhatsApp's service window closes and offers templates instead, media viewer, Arabic/RTL bubbles |
| Contacts | CSV import (phone/name/email/tags + any column → custom field; 8-digit numbers default to +965), export, tags, bulk tagging, opt-out tracking (STOP / إلغاء auto-unsubscribes) |
| Templates | Create & submit to Meta with live WhatsApp-style preview, variables with examples, header media, quick-reply / URL / call buttons, sync status from Meta |
| Campaigns | Audience by tags with exclusions, per-recipient personalisation (contact field / custom field / fixed text), send now or schedule, throttled sending, pause/resume/cancel, live funnel: sent → delivered → read → replied, per-recipient failure reasons |
| Chatbots | Drag-and-drop builder: message, buttons, list menu, question (saves answer), image/file, condition, tag, save detail, call your system (webhook), wait, hand over to team, end. Triggers: keywords (Arabic works), first message from new customer, fallback |
| Commerce | Orders (manual, API, Shopify, WooCommerce, WhatsApp catalog carts), products, **order-update automations** (placed / paid / shipped / delivered / canceled → template) |
| Developers | API keys, REST API (`/api/v1`), signed outgoing webhooks |
| Billing | Plan usage meters, invoices, plan switching, pay online (Tap: KNET / cards) or bank transfer |
| Overview | Conversations by day, median first-reply time, delivery/read rates, campaign results, busiest chatbots, replies per agent |

**For you (super admin, `/admin`)** — MRR, revenue by month, workspaces with status/plan/usage, create workspaces,
change plan, extend trials, suspend/reactivate, **open any workspace as its owner** (2-hour support session, audited),
plan builder with limits and feature flags, invoices (mark bank transfers paid), failed background jobs with retry, audit log.

**Plan enforcement is automatic**: contacts, messages per month, team members, numbers, live chatbots, and features
(campaigns / flows / commerce / API) are checked on every action. Expired trials and unpaid renewals produce invoices;
overdue invoices suspend the workspace (billing stays reachable so they can pay).

---

## Run it locally (5 minutes)

```bash
git clone https://github.com/Eslamatef1992/wappflow-api.git
git clone https://github.com/Eslamatef1992/wappflow-admin.git
cd wappflow-api && npm install
npm run seed -- --demo     # plans, super admin, and a "Demo Store" workspace with a demo number
npm run dev                # API on http://localhost:4000
# in another terminal
cd ../wappflow-admin && npm install && npm run dev   # dashboard on http://localhost:5173
```

| Login | Email | Password |
|---|---|---|
| Super admin | admin@wappflow.local | admin12345 |
| Workspace owner | owner@demo.local | demo12345 |
| Agent | agent@demo.local | demo12345 |

The demo workspace uses a **demo (mock) number**: nothing is sent to WhatsApp, messages are marked delivered/read
automatically, and the ✦ button in the inbox lets you play the customer. Type `hi` to see the welcome chatbot,
then tap its buttons right inside the chat. This is also how you demo the product to prospects before they have Meta access.

Tests: `npm test` (in this repo) runs an end-to-end suite (chatbot, inbox, 24h rule, campaigns with receipts, API + order automation,
Shopify HMAC, Meta webhook dedupe, plan limits, billing, suspension, impersonation, CSV import).

---

## Production on your VPS (Ubuntu)

```bash
# Node 20+, MariaDB/MySQL, Nginx, PM2 — clone both repos side by side
cd /var/www
git clone https://github.com/Eslamatef1992/wappflow-api.git
git clone https://github.com/Eslamatef1992/wappflow-admin.git
cd wappflow-admin && npm ci && npm run build          # → /var/www/wappflow-admin/dist
cd ../wappflow-api && npm ci
cp .env.example .env                               # fill it in — see comments in the file
npm run seed                                       # plans + your super admin (no demo data)
pm2 start deploy/ecosystem.config.cjs && pm2 save  # API also serves ../wappflow-admin/dist (or set WEB_DIST)
sudo cp deploy/nginx.conf /etc/nginx/sites-available/wappflow   # edit server_name, enable, then certbot
```

Updating later: `git pull` in both folders, `npm run build` in wappflow-admin, `pm2 restart wappflow`.

Migrations run automatically on start. Background work (webhook processing, campaign sending, chatbot delays,
billing cycle, outgoing webhooks) uses a database-backed queue — **no Redis needed**. Run one process with the
worker; extra API instances can set `WORKER=false`.

---

## Connecting WhatsApp (Meta)

### 1. Your Meta app (once, as the platform owner)
1. developers.facebook.com → create a **Business** app → add the **WhatsApp** product.
2. WhatsApp → Configuration → Webhook: callback `https://YOUR_DOMAIN/webhooks/whatsapp`, verify token = `META_VERIFY_TOKEN`, subscribe to **messages**.
3. Put the App ID and App Secret in `.env` (the secret verifies every webhook signature).

### 2. Onboarding a customer's number — two ways
- **Now (manual):** the customer (or you) creates a System User in their Business Manager with
  `whatsapp_business_messaging` + `whatsapp_business_management`, then pastes **Phone number ID, WABA ID and token**
  in *Settings → WhatsApp numbers → Connect number*. The platform verifies the token, subscribes your app to their
  WABA so webhooks arrive, and stores the token AES-256-GCM encrypted.
- **Later (one-click):** apply to Meta's **Tech Provider** program. Once approved, set `META_ES_CONFIG_ID`;
  the endpoint `POST /api/app/numbers/embedded-signup` is already implemented (code exchange → subscribe → register).
  You only need to add Meta's JS SDK popup button on the numbers page.

Meta bills conversation/template charges directly to each customer's WhatsApp Business Account — your plan price is
for the software. (If you'd rather resell messaging, add a markup on `templates_sent` in `usage_counters`.)

---

## REST API (for your customers' systems)

Auth: `X-API-Key: wsk_…` (created in *Settings → API & webhooks*).

```http
POST /api/v1/messages      {"to":"+96550000000","template":"order_shipped","variables":{"body":["Ali","#1042"]}}
POST /api/v1/messages      {"to":"+96550000000","text":"Hello"}               # only inside the 24h window
GET  /api/v1/messages/:id
POST /api/v1/contacts      {"phone":"+965…","name":"Ali","tags":["VIP"],"attributes":{"city":"Salmiya"}}
GET  /api/v1/contacts/:phone
GET  /api/v1/templates
POST /api/v1/orders        {"id":"A-1001","phone":"+965…","name":"Huda","total":19.5,"items":[…]}
PATCH /api/v1/orders/:id   {"status":"shipped","meta":{"tracking_url":"https://…"}}
```

Outgoing webhooks are signed: `X-WappFlow-Signature: sha256=HMAC_SHA256(secret, rawBody)`.
Events: `message.received`, `message.sent`, `message.status`, `contact.created`, `conversation.updated`,
`campaign.updated`, `order.created|paid|shipped|delivered|canceled`.

**Shopify:** Settings → Notifications → Webhooks (orders create/paid/fulfilled/cancelled, JSON) → URL from *Commerce → Store connections*.
**WooCommerce:** Settings → Advanced → Webhooks (order created/updated) → same.

---

## Billing setup
- Plans live in *Admin → Plans* (seeded: Starter 15, Growth 35, Business 79 KWD/month — change freely).
- **Bank transfer** works out of the box: set `BANK_DETAILS`, then mark invoices paid in *Admin → Invoices*.
- **Online (KNET, cards, Apple Pay) via Tap Payments**: set `TAP_SECRET_KEY`. Payment confirmation re-fetches the charge
  from Tap's API (never trusts the redirect). ⚠️ Test the full flow with a `sk_test_` key in Tap's sandbox before going live.
  MyFatoorah or another gateway can be added next to `createTapCharge` in `server/src/services/billing.js`.

---

## Where things live

| File | Responsibility |
|---|---|
| `src/whatsapp/client.js` | Cloud API calls (send, templates, media, phone info, embedded signup), mock mode |
| `src/whatsapp/inbound.js` | Webhook processing: contacts, conversations, opt-out, carts, receipts, campaign reply attribution |
| `src/services/messaging.js` | The single send path: 24h rule, plan limits, template rendering, usage counting |
| `src/services/flows.js` | Chatbot engine |
| `src/services/campaigns.js` | Audience, throttled batches |
| `src/services/billing.js` | Limits, invoices, subscription lifecycle, Tap |
| `src/services/commerce.js` | Orders, automations, Shopify/Woo mapping |
| `src/lib/jobs.js` | DB-backed job queue |

## Status and suggested next steps
Tested here on SQLite (all end-to-end tests pass, UI checked desktop + mobile). MySQL/MariaDB and PostgreSQL
use the same Knex migration but were not run in this environment — run `npm test` against a staging database once.

Good next additions, roughly in order of customer value:
1. Arabic interface (the UI already handles Arabic content and RTL messages; strings need extracting to i18n).
2. Media upload from the inbox (today: send by public link; inbound media is already proxied).
3. Embedded Signup button (backend done) once you're a Meta Tech Provider.
4. WhatsApp Flows (native forms), AI auto-replies, click-to-WhatsApp ad attribution.
5. Per-message cost estimates in the campaign editor using Meta's current country rates.
