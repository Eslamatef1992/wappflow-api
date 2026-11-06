import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { HttpError } from './lib/util.js';
import { requireAuth, requireTenant } from './lib/auth.js';

import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import webhookRoutes from './routes/webhooks.js';
import publicApi from './routes/publicApi.js';
import contacts from './routes/app/contacts.js';
import inbox from './routes/app/inbox.js';
import templates from './routes/app/templates.js';
import campaigns from './routes/app/campaigns.js';
import flows from './routes/app/flows.js';
import commerce from './routes/app/commerce.js';
import settings from './routes/app/settings.js';
import billing from './routes/app/billing.js';
import analytics from './routes/app/analytics.js';
import invoices from './routes/app/invoices.js';
import otp from './routes/app/otp.js';
import invoicePage from './routes/invoicePage.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.env === 'production' ? [config.appUrl, ...config.siteUrls] : true, credentials: true }));
  // keep the raw body: webhook signatures (Meta, Shopify, WooCommerce) are computed over it
  app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

  app.get('/health', (_req, res) => res.json({ ok: true, brand: config.brand, time: Date.now() }));

  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60_000, limit: 30 }));
  app.use('/api/auth/signup', rateLimit({ windowMs: 60 * 60_000, limit: 10 }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: 600 }), publicApi);
  app.use(webhookRoutes);
  app.use(invoicePage); // public invoice links sent on WhatsApp: /i/<token>

  const tenantApp = express.Router();
  tenantApp.use(requireAuth);
  tenantApp.use(requireTenant({ allowSuspended: true }), billing); // billing stays reachable while suspended
  tenantApp.use(requireTenant());
  for (const r of [analytics, contacts, inbox, templates, campaigns, flows, commerce, invoices, otp, settings]) tenantApp.use(r);
  app.use('/api/app', tenantApp);

  // serve the built admin dashboard from the same server in production.
  // Set WEB_DIST to the admin repo's dist folder; defaults to ../wappflow-admin/dist (repos cloned side by side).
  const dist = process.env.WEB_DIST
    ? path.resolve(process.env.WEB_DIST)
    : [path.join(config.root, '..', 'wappflow-admin', 'dist'), path.join(config.root, '..', 'web', 'dist')].find((d) => fs.existsSync(d));
  if (dist && fs.existsSync(dist)) {
    app.use(express.static(dist, { maxAge: '7d', index: false }));
    app.get(/^\/(?!api|webhooks|hooks|socket\.io|i\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use((req, _res, next) => next(new HttpError(404, `Not found: ${req.method} ${req.path}`)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && config.env === 'production' ? 'Server error' : err.message, details: err.details });
  });
  return app;
}
