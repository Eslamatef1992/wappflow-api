import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function dbConfig() {
  const client = env.DB_CLIENT || 'better-sqlite3';
  if (client === 'better-sqlite3') {
    return {
      client,
      connection: { filename: env.DB_FILE || path.join(root, 'data', 'wappflow.sqlite') },
      useNullAsDefault: true,
      pool: {
        afterCreate: (conn, cb) => {
          conn.pragma('journal_mode = WAL');
          conn.pragma('foreign_keys = ON');
          cb();
        },
      },
    };
  }
  return {
    client, // mysql2 | pg
    connection: env.DATABASE_URL || {
      host: env.DB_HOST || '127.0.0.1',
      port: +(env.DB_PORT || (client === 'pg' ? 5432 : 3306)),
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      database: env.DB_NAME || 'wappflow',
      ...(client === 'mysql2' ? { charset: 'utf8mb4' } : {}),
    },
    pool: { min: 2, max: 20 },
  };
}

export const config = {
  root,
  env: env.NODE_ENV || 'development',
  port: +(env.PORT || 4000),
  appUrl: env.APP_URL || 'http://localhost:5173', // dashboard
  // public website(s) allowed to read plans for the pricing section (comma separated)
  siteUrls: (env.SITE_URL || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  apiUrl: env.API_URL || 'http://localhost:4000', // public URL of this server (webhooks)
  brand: env.BRAND_NAME || 'WappFlow',
  jwtSecret: env.JWT_SECRET || 'dev-jwt-secret-change-me',
  appKey: env.APP_KEY || 'dev-app-key-change-me',
  db: dbConfig(),
  meta: {
    graphVersion: env.META_GRAPH_VERSION || 'v23.0',
    appId: env.META_APP_ID || '',
    appSecret: env.META_APP_SECRET || '', // verifies X-Hub-Signature-256 on webhooks
    verifyToken: env.META_VERIFY_TOKEN || 'wappflow-verify-token',
    embeddedSignupConfigId: env.META_ES_CONFIG_ID || '',
  },
  tap: {
    secretKey: env.TAP_SECRET_KEY || '', // empty = online payments disabled, manual invoices only
    apiBase: env.TAP_API_BASE || 'https://api.tap.company/v2',
  },
  sendRatePerSecond: +(env.SEND_RATE_PER_SEC || 20),
  trialDays: +(env.TRIAL_DAYS || 14),
  graceDays: +(env.GRACE_DAYS || 5),
  allowSignup: env.ALLOW_SIGNUP !== 'false',
  mockStatusDelayMs: +(env.MOCK_STATUS_DELAY_MS || 1500),
};
