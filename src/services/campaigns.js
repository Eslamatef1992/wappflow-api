// Broadcast campaigns: audience resolution, throttled sending through the job queue, live stats.
import { config } from '../config.js';
import { db, j, now } from '../db.js';
import { bad } from '../lib/util.js';
import { publish } from '../lib/events.js';
import { enqueue, registerJob } from '../lib/jobs.js';
import { sendToContact, buildTemplateMessage, contactCtx } from './messaging.js';
import { usageFor, planFor } from './billing.js';

/** Query builder for contact ids matching an audience definition. */
export function audienceQuery(tenantId, audience = {}) {
  const q = db('contacts').where({ 'contacts.tenant_id': tenantId, 'contacts.opted_in': true });
  if (audience.contactIds?.length) q.whereIn('contacts.id', audience.contactIds);
  else if (!audience.all && audience.tagIds?.length) {
    q.whereIn('contacts.id', db('contact_tags').whereIn('tag_id', audience.tagIds).select('contact_id'));
  } else if (!audience.all) q.whereRaw('1 = 0');
  if (audience.excludeTagIds?.length) {
    q.whereNotIn('contacts.id', db('contact_tags').whereIn('tag_id', audience.excludeTagIds).select('contact_id'));
  }
  return q;
}

/**
 * Recalculate a campaign's counters from its recipient rows. Counting (instead of incrementing)
 * keeps the numbers exact even when receipts for one message are processed at the same time.
 */
export async function refreshCampaignCounts(campaignId) {
  const rows = await db('campaign_recipients').where({ campaign_id: campaignId }).groupBy('status').select('status').count({ c: '*' });
  const by = Object.fromEntries(rows.map((r) => [r.status, +r.c]));
  const replied = +(await db('campaign_recipients').where({ campaign_id: campaignId }).whereNotNull('replied_at').count({ c: '*' }).first()).c;
  const read = by.read || 0;
  const delivered = (by.delivered || 0) + read; // a read message was delivered
  const counts = { sent: (by.sent || 0) + delivered, delivered, read_count: read, failed: by.failed || 0, replied };
  await db('campaigns').where({ id: campaignId }).update(counts);
  return counts;
}

export async function countAudience(tenantId, audience) {
  return +(await audienceQuery(tenantId, audience).count({ c: 'contacts.id' }).first()).c;
}

export async function launchCampaign(tenant, campaign) {
  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) throw bad(`Campaign is ${campaign.status}`);
  const template = await db('templates').where({ id: campaign.template_id, tenant_id: tenant.id }).first();
  if (!template) throw bad('Choose a template');
  if (template.status !== 'APPROVED') throw bad('Template is not approved by WhatsApp yet');

  if (campaign.status !== 'paused') {
    const audience = j(campaign.audience, {});
    const total = await countAudience(tenant.id, audience);
    if (!total) throw bad('The audience is empty (opted-out contacts are skipped)');

    const plan = await planFor(tenant);
    const limit = plan.limits?.monthly_messages;
    if (limit >= 0) {
      const used = (await usageFor(tenant.id)).monthly_messages;
      if (used + total > limit) throw bad(`This campaign needs ${total} messages but only ${Math.max(0, limit - used)} remain in your plan this month.`);
    }
    // snapshot recipients in chunks
    const ids = await audienceQuery(tenant.id, audience).select('contacts.id');
    for (let i = 0; i < ids.length; i += 500) {
      await db('campaign_recipients').insert(ids.slice(i, i + 500).map((r) => ({ campaign_id: campaign.id, contact_id: r.id, status: 'pending' })));
    }
    await db('campaigns').where({ id: campaign.id }).update({ total: ids.length, sent: 0, delivered: 0, read_count: 0, failed: 0, replied: 0 });
  }
  await db('campaigns').where({ id: campaign.id }).update({ status: 'running', started_at: campaign.started_at || now() });
  await enqueue('campaign.batch', { campaignId: campaign.id });
  await publish(tenant.id, 'campaign.updated', { id: campaign.id, status: 'running' });
}

registerJob('campaign.start', async ({ campaignId }) => {
  const c = await db('campaigns').where({ id: campaignId }).first();
  if (!c || c.status !== 'scheduled') return;
  const tenant = await db('tenants').where({ id: c.tenant_id }).first();
  try {
    await launchCampaign(tenant, c);
  } catch (e) {
    await db('campaigns').where({ id: c.id }).update({ status: 'failed' });
    await publish(tenant.id, 'campaign.updated', { id: c.id, status: 'failed', error: e.message });
  }
});

registerJob('campaign.batch', async ({ campaignId }) => {
  const c = await db('campaigns').where({ id: campaignId }).first();
  if (!c || c.status !== 'running') return;
  const tenant = await db('tenants').where({ id: c.tenant_id }).first();
  if (tenant.status === 'suspended') {
    await db('campaigns').where({ id: c.id }).update({ status: 'paused' });
    return;
  }
  const template = await db('templates').where({ id: c.template_id }).first();
  const variables = j(c.variables, {});
  const batchSize = Math.max(1, config.sendRatePerSecond);
  const batch = await db('campaign_recipients').where({ campaign_id: c.id, status: 'pending' }).limit(batchSize);

  if (!batch.length) {
    await db('campaigns').where({ id: c.id }).update({ status: 'completed', completed_at: now() });
    await publish(tenant.id, 'campaign.updated', { id: c.id, status: 'completed' });
    return;
  }

  const contacts = await db('contacts').whereIn('id', batch.map((r) => r.contact_id));
  const started = Date.now();
  await Promise.all(batch.map(async (r) => {
    const contact = contacts.find((x) => x.id === r.contact_id);
    if (!contact || !contact.opted_in) {
      await db('campaign_recipients').where({ id: r.id }).update({ status: 'failed', error: 'Opted out' });
      return;
    }
    try {
      const msg = buildTemplateMessage(template, variables, contactCtx(contact));
      const sent = await sendToContact({ tenant, contact, numberId: c.wa_number_id, message: msg, campaignId: c.id });
      // a fast receipt may already have updated the message before we stored its wamid here
      const latest = await db('messages').where({ id: sent.id }).first();
      const status = ['delivered', 'read'].includes(latest?.status) ? latest.status : 'sent';
      await db('campaign_recipients').where({ id: r.id, status: 'pending' }).update({ status, wamid: sent.wamid, sent_at: now() });
    } catch (e) {
      await db('campaign_recipients').where({ id: r.id }).update({ status: 'failed', error: String(e.message).slice(0, 500), wamid: e.messageRecord?.wamid || null });
    }
  }));
  const counts = await refreshCampaignCounts(c.id);
  await publish(tenant.id, 'campaign.progress', { id: c.id, sent: counts.sent, failed: counts.failed, delivered: counts.delivered, read: counts.read_count, total: c.total });
  // keep roughly `sendRatePerSecond` messages per second
  return { retryInMs: Math.max(0, 1000 - (Date.now() - started)) };
});

export function serializeCampaign(c) {
  return c && { ...c, audience: j(c.audience, {}), variables: j(c.variables, {}), read: c.read_count };
}
