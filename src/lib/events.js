// Realtime (Socket.IO rooms per tenant) + outgoing webhooks to the tenant's own systems.
import { db, j, now } from '../db.js';
import { enqueue, registerJob } from './jobs.js';
import { hmacHex } from './util.js';

let io = null;
export const setIO = (instance) => { io = instance; };

export function emitTenant(tenantId, event, data) {
  io?.to(`tenant:${tenantId}`).emit(event, data);
}

export function emitAdmin(event, data) {
  io?.to('superadmin').emit(event, data);
}

/** Emit to dashboard sockets AND queue delivery to subscribed webhook endpoints. */
export async function publish(tenantId, event, data) {
  emitTenant(tenantId, event, data);
  const endpoints = await db('webhook_endpoints').where({ tenant_id: tenantId, is_active: true });
  for (const ep of endpoints) {
    const events = j(ep.events, ['*']);
    if (events.includes('*') || events.includes(event)) {
      await enqueue('webhook.deliver', { endpointId: ep.id, event, data, at: now() });
    }
  }
}

registerJob('webhook.deliver', async ({ endpointId, event, data, at }) => {
  const ep = await db('webhook_endpoints').where({ id: endpointId }).first();
  if (!ep || !ep.is_active) return;
  const body = JSON.stringify({ event, created_at: at, data });
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Wasla-Event': event,
      'X-Wasla-Signature': `sha256=${hmacHex(ep.secret, body)}`,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    await db('webhook_endpoints').where({ id: ep.id }).increment('failures', 1);
    throw new Error(`Endpoint responded ${res.status}`);
  }
  if (ep.failures) await db('webhook_endpoints').where({ id: ep.id }).update({ failures: 0 });
});
