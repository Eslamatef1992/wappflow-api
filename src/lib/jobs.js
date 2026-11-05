// Minimal durable job queue on top of the database: no Redis needed.
// Safe to run one worker per process; locking uses a conditional UPDATE so several
// processes (e.g. PM2 cluster) never pick the same job.
import { db, j, s, now, insert } from '../db.js';

const handlers = new Map();
let timer = null;
let busy = false;

export function registerJob(type, fn) {
  handlers.set(type, fn);
}

export async function enqueue(type, payload = {}, { runAt = now(), delayMs = 0 } = {}) {
  return insert('jobs', { type, payload: s(payload), status: 'pending', run_at: runAt + delayMs, attempts: 0 });
}

async function claim(limit = 25) {
  const candidates = await db('jobs')
    .where('status', 'pending')
    .andWhere('run_at', '<=', now())
    .orderBy('run_at')
    .limit(limit)
    .select('id');
  const claimed = [];
  for (const { id } of candidates) {
    const n = await db('jobs').where({ id, status: 'pending' }).update({ status: 'running', locked_at: now() });
    if (n) claimed.push(await db('jobs').where({ id }).first());
  }
  return claimed;
}

async function runOne(job) {
  const fn = handlers.get(job.type);
  try {
    if (!fn) throw new Error(`No handler for job type ${job.type}`);
    const result = await fn(j(job.payload, {}), job);
    if (result && typeof result.retryInMs === 'number') {
      // handler asked to be called again later (e.g. campaign batches, rate limiting)
      await db('jobs').where({ id: job.id }).update({ status: 'pending', run_at: now() + result.retryInMs, locked_at: null });
    } else {
      await db('jobs').where({ id: job.id }).update({ status: 'done', locked_at: null });
    }
  } catch (err) {
    const attempts = job.attempts + 1;
    const failed = attempts >= 5;
    await db('jobs').where({ id: job.id }).update({
      status: failed ? 'failed' : 'pending',
      attempts,
      last_error: String(err?.message || err).slice(0, 2000),
      run_at: now() + Math.min(2 ** attempts * 5000, 15 * 60_000),
      locked_at: null,
    });
    if (failed) console.error(`[jobs] ${job.type}#${job.id} failed permanently:`, err?.message);
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    // recover jobs stuck in "running" (process crashed mid-job)
    await db('jobs').where('status', 'running').andWhere('locked_at', '<', now() - 10 * 60_000)
      .update({ status: 'pending', locked_at: null });
    const jobs = await claim();
    await Promise.all(jobs.map(runOne));
  } catch (e) {
    console.error('[jobs] tick error', e.message);
  } finally {
    busy = false;
  }
}

export function startWorker(intervalMs = 1000) {
  if (timer) return;
  timer = setInterval(tick, intervalMs);
  console.log('[jobs] worker started');
}

export function stopWorker() {
  clearInterval(timer);
  timer = null;
}

/** For tests: run all due jobs now. */
export async function drain(maxRounds = 50) {
  for (let i = 0; i < maxRounds; i++) {
    const jobs = await claim(100);
    if (!jobs.length) return;
    await Promise.all(jobs.map(runOne));
  }
}
