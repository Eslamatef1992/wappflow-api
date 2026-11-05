// Account emails through Mailgun (fake Mailgun API): welcome, invoice, receipt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const sent = [];
let failNext = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (failNext > 0) { failNext--; res.writeHead(500); return res.end('boom'); }
    const ok = req.url === '/v3/wappflow.online/messages' && req.headers.authorization === `Basic ${Buffer.from('api:key-123').toString('base64')}`;
    if (!ok) { res.writeHead(401); return res.end('Forbidden'); }
    sent.push(Object.fromEntries(new URLSearchParams(body)));
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: `<m${sent.length}@mg>`, message: 'Queued' }));
  });
});

const dbFile = path.join(os.tmpdir(), `wf-email-${Date.now()}.sqlite`);
let server; let base; let db; let admin; let jobs;

before(async () => {
  await new Promise((r) => fake.listen(0, r));
  Object.assign(process.env, {
    DB_FILE: dbFile, DB_CLIENT: '', MAILGUN_API_KEY: 'key-123', MAILGUN_DOMAIN: 'wappflow.online',
    MAILGUN_FROM: 'WappFlow <billing@wappflow.online>', MAILGUN_API_BASE: `http://127.0.0.1:${fake.address().port}`,
    APP_URL: 'https://admin.wappflow.online', SITE_URL: 'https://www.wappflow.online',
  });
  execFileSync('node', ['src/scripts/seed.js'], { env: process.env, cwd: path.resolve(import.meta.dirname, '..') });
  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db.js'));
  jobs = await import('../src/lib/jobs.js');
  jobs.startWorker(30);
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
  admin = (await call('POST', '/api/auth/login', { email: 'admin@wappflow.local', password: 'admin12345' })).data.token;
});
after(async () => { jobs.stopWorker(); server.close(); fake.close(); await db.destroy(); fs.rmSync(dbFile, { force: true }); });

async function call(method, url, body, token) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); } return null; };
const runDelayedNow = () => db('jobs').where({ type: 'email.send', status: 'pending' }).update({ run_at: Date.now() });

let owner;
test('signing up sends a welcome email to the owner', async () => {
  const r = await call('POST', '/api/auth/signup', { company: 'Qahwa House', name: 'Sara Ali', email: 'sara@qahwa.test', password: 'secret123' });
  assert.equal(r.status, 201);
  owner = r.data.token;
  const mail = await waitFor(() => sent.find((m) => m.to.includes('sara@qahwa.test')));
  assert.ok(mail, 'welcome email sent');
  assert.equal(mail.from, 'WappFlow <billing@wappflow.online>');
  assert.equal(mail.to, 'Sara Ali <sara@qahwa.test>');
  assert.match(mail.subject, /Welcome to WappFlow, Qahwa House/);
  assert.match(mail.html, /Welcome to WappFlow, Sara/);
  assert.match(mail.html, /أهلاً بك في WappFlow/);
  assert.match(mail.html, /https:\/\/admin\.wappflow\.online\/app/);
  assert.match(mail.html, /https:\/\/www\.wappflow\.online\/brand\/wappflow-logo\.png/);
  assert.match(mail.text, /Open your dashboard: https:\/\/admin\.wappflow\.online\/app/);
});

test('choosing a plan emails the invoice (unless it is paid first)', async () => {
  sent.length = 0;
  const plans = (await call('GET', '/api/app/billing', null, owner)).data.plans;
  const inv = (await call('POST', '/api/app/billing/subscribe', { planId: plans[0].id }, owner)).data;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0, 'invoice email waits 2 minutes');
  await runDelayedNow();
  const mail = await waitFor(() => sent.find((m) => m.subject.startsWith('Invoice')));
  assert.ok(mail);
  assert.match(mail.subject, new RegExp(`Invoice ${inv.number} · 15\\.000 KWD`));
  assert.match(mail.html, /Pay now/);
  assert.match(mail.html, /https:\/\/admin\.wappflow\.online\/app\/billing/);
  assert.match(mail.html, /ادفع الآن/);
});

test('paying sends a receipt; an invoice paid within 2 minutes is not emailed', async () => {
  sent.length = 0;
  const plans = (await call('GET', '/api/app/billing', null, owner)).data.plans;
  const inv = (await call('POST', '/api/app/billing/subscribe', { planId: plans[1].id }, owner)).data;
  assert.equal((await call('POST', `/api/admin/invoices/${inv.id}/mark-paid`, {}, admin)).status, 200);
  const receipt = await waitFor(() => sent.find((m) => m.subject.startsWith('Payment received')));
  assert.ok(receipt);
  assert.match(receipt.subject, new RegExp(inv.number));
  assert.match(receipt.html, /Your plan is active until/);
  assert.match(receipt.html, /35\.000 KWD/);
  assert.match(receipt.html, /تم استلام الدفع/);
  await runDelayedNow();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!sent.some((m) => m.subject.startsWith(`Invoice ${inv.number}`)), 'paid invoice not emailed');
});

test('Mailgun errors are retried by the job queue', async () => {
  sent.length = 0;
  failNext = 1;
  const r = await call('POST', '/api/admin/tenants', { company: 'Retry Co', name: 'Omar', email: 'omar@retry.test', password: 'secret123', planId: 1 }, admin);
  assert.equal(r.status, 201);
  await waitFor(() => db('jobs').where({ type: 'email.send' }).andWhere('attempts', '>', 0).first());
  await runDelayedNow();
  assert.ok(await waitFor(() => sent.find((m) => m.to.includes('omar@retry.test'))), 'sent after retry');
});

test('admin can send test emails and see the email status', async () => {
  sent.length = 0;
  assert.deepEqual((await call('GET', '/api/admin/email', null, admin)).data, { enabled: true, from: 'WappFlow <billing@wappflow.online>' });
  const r = await call('POST', '/api/admin/email/test', { to: 'me@wappflow.online', kind: 'receipt' }, admin);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(sent[0].to, 'me@wappflow.online');
  assert.match(sent[0].subject, /^\[Test\] Payment received/);
  assert.equal((await call('POST', '/api/admin/email/test', { to: 'nope' }, admin)).status, 400);
});
