// Full schema. Timestamps are stored as epoch milliseconds (bigint) and JSON as text,
// so the same migration runs on SQLite (dev), MySQL/MariaDB and PostgreSQL (prod).

export async function up(knex) {
  const ts = (t, ...cols) => cols.forEach((c) => t.bigInteger(c).nullable());

  await knex.schema.createTable('plans', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.decimal('price_monthly', 12, 3).notNullable().defaultTo(0);
    t.decimal('price_yearly', 12, 3).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable().defaultTo('KWD');
    t.text('limits'); // {contacts, monthly_messages, agents, numbers, flows}
    t.text('features'); // {campaigns, inbox, flows, commerce, api}
    t.text('description');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort').defaultTo(0);
    ts(t, 'created_at');
  });

  await knex.schema.createTable('tenants', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('status').notNullable().defaultTo('trial'); // trial | active | past_due | suspended
    t.integer('plan_id').unsigned().references('plans.id');
    t.string('timezone').defaultTo('Asia/Kuwait');
    t.string('locale').defaultTo('en');
    t.text('settings');
    ts(t, 'trial_ends_at', 'created_at');
  });

  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().nullable().references('tenants.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('email').notNullable().unique();
    t.string('password_hash').notNullable();
    t.string('role').notNullable().defaultTo('agent'); // superadmin | owner | admin | agent
    t.boolean('is_active').notNullable().defaultTo(true);
    ts(t, 'last_seen_at', 'created_at');
  });

  await knex.schema.createTable('subscriptions', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('plan_id').unsigned().notNullable().references('plans.id');
    t.string('status').notNullable().defaultTo('trialing'); // trialing | active | past_due | canceled
    t.string('billing_interval').notNullable().defaultTo('monthly');
    ts(t, 'current_period_start', 'current_period_end', 'canceled_at', 'created_at');
  });

  await knex.schema.createTable('invoices', (t) => {
    t.increments('id');
    t.string('number').notNullable().unique();
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('subscription_id').unsigned().nullable();
    t.integer('plan_id').unsigned().nullable();
    t.decimal('amount', 12, 3).notNullable();
    t.string('currency', 3).notNullable().defaultTo('KWD');
    t.string('status').notNullable().defaultTo('unpaid'); // unpaid | paid | void
    t.string('provider').nullable(); // manual | tap
    t.string('provider_ref').nullable();
    t.text('notes');
    ts(t, 'period_start', 'period_end', 'due_at', 'paid_at', 'created_at');
  });

  await knex.schema.createTable('usage_counters', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('period', 7).notNullable(); // YYYY-MM
    t.integer('messages_sent').notNullable().defaultTo(0);
    t.integer('messages_received').notNullable().defaultTo(0);
    t.integer('templates_sent').notNullable().defaultTo(0);
    t.unique(['tenant_id', 'period']);
  });

  await knex.schema.createTable('wa_numbers', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('label');
    t.string('display_phone');
    t.string('phone_number_id').notNullable().unique();
    t.string('waba_id');
    t.text('access_token_enc');
    t.string('mode').notNullable().defaultTo('live'); // live | mock
    t.string('status').defaultTo('connected');
    t.string('quality_rating');
    t.boolean('is_default').notNullable().defaultTo(false);
    ts(t, 'created_at');
  });

  await knex.schema.createTable('contacts', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('wa_id', 32).notNullable(); // digits only, E.164 without +
    t.string('name');
    t.string('email');
    t.text('attributes');
    t.boolean('opted_in').notNullable().defaultTo(true);
    t.string('source').defaultTo('manual');
    ts(t, 'opted_out_at', 'last_inbound_at', 'created_at');
    t.unique(['tenant_id', 'wa_id']);
  });

  await knex.schema.createTable('tags', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('color').defaultTo('#16a34a');
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('contact_tags', (t) => {
    t.integer('contact_id').unsigned().notNullable().references('contacts.id').onDelete('CASCADE');
    t.integer('tag_id').unsigned().notNullable().references('tags.id').onDelete('CASCADE');
    t.primary(['contact_id', 'tag_id']);
  });

  await knex.schema.createTable('templates', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('wa_number_id').unsigned().nullable();
    t.string('meta_id');
    t.string('name').notNullable();
    t.string('language').notNullable().defaultTo('en');
    t.string('category').notNullable().defaultTo('MARKETING');
    t.string('status').notNullable().defaultTo('PENDING');
    t.text('components');
    t.text('rejected_reason');
    ts(t, 'created_at', 'updated_at');
    t.unique(['tenant_id', 'name', 'language']);
  });

  await knex.schema.createTable('campaigns', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.integer('wa_number_id').unsigned().nullable();
    t.integer('template_id').unsigned().nullable();
    t.text('audience'); // {all: bool, tagIds: [], excludeTagIds: [], contactIds: []}
    t.text('variables'); // mapping for body/header params
    t.string('status').notNullable().defaultTo('draft'); // draft|scheduled|running|paused|completed|failed|canceled
    t.integer('total').defaultTo(0);
    t.integer('sent').defaultTo(0);
    t.integer('delivered').defaultTo(0);
    t.integer('read_count').defaultTo(0);
    t.integer('failed').defaultTo(0);
    t.integer('replied').defaultTo(0);
    t.integer('created_by').unsigned().nullable();
    ts(t, 'scheduled_at', 'started_at', 'completed_at', 'created_at');
  });

  await knex.schema.createTable('campaign_recipients', (t) => {
    t.increments('id');
    t.integer('campaign_id').unsigned().notNullable().references('campaigns.id').onDelete('CASCADE');
    t.integer('contact_id').unsigned().notNullable();
    t.string('status').notNullable().defaultTo('pending'); // pending|sent|delivered|read|failed
    t.string('wamid').index();
    t.text('error');
    ts(t, 'sent_at', 'replied_at');
    t.index(['campaign_id', 'status']);
  });

  await knex.schema.createTable('conversations', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('contact_id').unsigned().notNullable().references('contacts.id').onDelete('CASCADE');
    t.integer('wa_number_id').unsigned().nullable();
    t.string('status').notNullable().defaultTo('open'); // open | pending | resolved
    t.integer('assigned_user_id').unsigned().nullable();
    t.integer('unread_count').notNullable().defaultTo(0);
    t.text('last_message_preview');
    t.boolean('bot_active').notNullable().defaultTo(true);
    t.text('flow_session');
    ts(t, 'last_message_at', 'last_inbound_at', 'created_at');
    t.index(['tenant_id', 'status']);
  });

  await knex.schema.createTable('messages', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('conversation_id').unsigned().notNullable().references('conversations.id').onDelete('CASCADE');
    t.integer('contact_id').unsigned().notNullable();
    t.string('direction', 8).notNullable(); // in | out | note
    t.string('type', 24).notNullable().defaultTo('text');
    t.text('content'); // raw payload (JSON)
    t.text('body'); // plain text preview
    t.string('wamid').nullable().index();
    t.string('status', 16).defaultTo('queued'); // queued|sent|delivered|read|failed|received
    t.text('error');
    t.integer('sender_user_id').unsigned().nullable();
    t.integer('campaign_id').unsigned().nullable();
    t.integer('flow_id').unsigned().nullable();
    ts(t, 'created_at');
    t.index(['conversation_id', 'id']);
  });

  await knex.schema.createTable('quick_replies', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('shortcut').notNullable();
    t.text('body').notNullable();
  });

  await knex.schema.createTable('flows', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('trigger_type').notNullable().defaultTo('keyword'); // keyword | any_message | new_contact
    t.text('trigger_value'); // comma separated keywords
    t.text('graph'); // {nodes, edges}
    t.boolean('is_active').notNullable().defaultTo(false);
    t.integer('runs').notNullable().defaultTo(0);
    ts(t, 'created_at', 'updated_at');
  });

  await knex.schema.createTable('products', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.text('description');
    t.decimal('price', 12, 3).notNullable().defaultTo(0);
    t.string('currency', 3).notNullable().defaultTo('KWD');
    t.string('sku');
    t.string('retailer_id'); // id in the Meta catalog, for product messages
    t.text('image_url');
    t.boolean('is_active').notNullable().defaultTo(true);
    ts(t, 'created_at');
  });

  await knex.schema.createTable('orders', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('contact_id').unsigned().nullable();
    t.string('external_id');
    t.string('source').notNullable().defaultTo('manual'); // manual|api|shopify|woocommerce|whatsapp
    t.string('status').notNullable().defaultTo('created'); // created|paid|shipped|delivered|canceled
    t.decimal('total', 12, 3).defaultTo(0);
    t.string('currency', 3).defaultTo('KWD');
    t.text('items');
    t.text('meta');
    ts(t, 'created_at', 'updated_at');
  });

  await knex.schema.createTable('automations', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('event').notNullable(); // order.created | order.paid | order.shipped | order.delivered | order.canceled
    t.integer('template_id').unsigned().notNullable();
    t.integer('wa_number_id').unsigned().nullable();
    t.text('variables');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('runs').defaultTo(0);
  });

  await knex.schema.createTable('integrations', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('type').notNullable(); // shopify | woocommerce
    t.string('name');
    t.string('token').notNullable().unique(); // used in the inbound hook URL
    t.text('secret_enc');
    t.boolean('is_active').notNullable().defaultTo(true);
    ts(t, 'last_event_at', 'created_at');
  });

  await knex.schema.createTable('api_keys', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('prefix', 16).notNullable();
    t.string('key_hash').notNullable().unique();
    ts(t, 'last_used_at', 'created_at');
  });

  await knex.schema.createTable('webhook_endpoints', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.text('url').notNullable();
    t.text('events'); // ["message.received", ...] or ["*"]
    t.string('secret').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('failures').defaultTo(0);
    ts(t, 'created_at');
  });

  await knex.schema.createTable('jobs', (t) => {
    t.increments('id');
    t.string('type').notNullable();
    t.text('payload');
    t.string('status').notNullable().defaultTo('pending'); // pending|running|done|failed
    t.integer('attempts').notNullable().defaultTo(0);
    t.text('last_error');
    t.bigInteger('run_at').notNullable();
    t.bigInteger('locked_at').nullable();
    t.index(['status', 'run_at']);
  });

  await knex.schema.createTable('platform_settings', (t) => {
    t.string('key').primary();
    t.text('value');
  });

  await knex.schema.createTable('audit_logs', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().nullable();
    t.integer('user_id').unsigned().nullable();
    t.string('action').notNullable();
    t.text('meta');
    ts(t, 'created_at');
  });
}

export async function down(knex) {
  for (const t of [
    'audit_logs', 'platform_settings', 'jobs', 'webhook_endpoints', 'api_keys', 'integrations',
    'automations', 'orders', 'products', 'flows', 'quick_replies', 'messages', 'conversations',
    'campaign_recipients', 'campaigns', 'templates', 'contact_tags', 'tags', 'contacts',
    'wa_numbers', 'usage_counters', 'invoices', 'subscriptions', 'users', 'tenants', 'plans',
  ]) await knex.schema.dropTableIfExists(t);
}
