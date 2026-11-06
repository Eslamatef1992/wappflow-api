// WhatsApp OTP: verification codes sent through a workspace's number, paid with prepaid credits.
export async function up(knex) {
  await knex.schema.createTable('otp_codes', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.string('phone', 20).notNullable();
    t.string('code_hash', 64).notNullable();
    t.string('status', 16).notNullable().defaultTo('pending'); // pending | verified | expired | failed | blocked
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('message_id').unsigned();
    t.string('reference', 120); // the caller's own id (user id, session…)
    t.text('error');
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('verified_at');
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'phone', 'id']);
    t.index(['tenant_id', 'id']);
  });

  await knex.schema.createTable('otp_packs', (t) => {
    t.increments('id');
    t.string('name', 80).notNullable();
    t.string('name_ar', 80);
    t.integer('credits').notNullable();
    t.decimal('price', 12, 3).notNullable();
    t.string('currency', 3).notNullable().defaultTo('KWD');
    t.boolean('is_active').notNullable().defaultTo(true);
    t.integer('sort').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('credit_ledger', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('delta').notNullable(); // +bought / +granted, -1 per code sent, +1 refund
    t.integer('balance_after').notNullable();
    t.string('reason', 32).notNullable(); // purchase | grant | otp | refund
    t.string('ref', 64);
    t.integer('user_id').unsigned();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'id']);
  });

  await knex.schema.alterTable('tenants', (t) => { t.integer('otp_credits').notNullable().defaultTo(0); });
  await knex.schema.alterTable('invoices', (t) => {
    t.integer('otp_pack_id').unsigned().nullable(); // set for credit purchases (not plan invoices)
    t.integer('credits').unsigned().nullable();
  });

  // OTP is part of the Growth (35 KWD) and Business plans, not Starter
  for (const plan of await knex('plans').select('id', 'slug', 'features', 'price_monthly')) {
    let f = {}; try { f = JSON.parse(plan.features || '{}') || {}; } catch { f = {}; }
    f.otp = ['growth', 'business'].includes(plan.slug) || (!['starter'].includes(plan.slug) && +plan.price_monthly >= 35);
    await knex('plans').where({ id: plan.id }).update({ features: JSON.stringify(f) });
  }

  const created_at = Date.now();
  await knex('otp_packs').insert([
    { name: '500 codes', name_ar: '500 رمز', credits: 500, price: 10, currency: 'KWD', sort: 1, created_at },
    { name: '2,000 codes', name_ar: '2,000 رمز', credits: 2000, price: 35, currency: 'KWD', sort: 2, created_at },
    { name: '10,000 codes', name_ar: '10,000 رمز', credits: 10000, price: 150, currency: 'KWD', sort: 3, created_at },
  ]);
}

export async function down(knex) {
  await knex.schema.alterTable('invoices', (t) => { t.dropColumn('otp_pack_id'); t.dropColumn('credits'); });
  await knex.schema.alterTable('tenants', (t) => { t.dropColumn('otp_credits'); });
  await knex.schema.dropTable('credit_ledger');
  await knex.schema.dropTable('otp_packs');
  await knex.schema.dropTable('otp_codes');
}
