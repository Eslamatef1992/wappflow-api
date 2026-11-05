// Invoices that a workspace sends to its own customers over WhatsApp (from a POS, website or the dashboard).
export async function up(knex) {
  await knex.schema.createTable('sales_invoices', (t) => {
    t.increments('id');
    t.integer('tenant_id').unsigned().notNullable().references('tenants.id').onDelete('CASCADE');
    t.integer('contact_id').unsigned().references('contacts.id').onDelete('SET NULL');
    t.string('number', 64).notNullable();
    t.string('token', 64).notNullable().unique(); // public link: /i/<token>
    t.string('source', 32).notNullable().defaultTo('api'); // api | manual
    t.string('status', 16).notNullable().defaultTo('unpaid'); // unpaid | paid | void
    t.decimal('total', 14, 3).notNullable().defaultTo(0);
    t.string('currency', 8).notNullable().defaultTo('KWD');
    t.text('items');
    t.string('due_date', 10);
    t.text('pdf_url');
    t.text('pay_url');
    t.text('notes');
    t.text('meta');
    t.integer('message_id').unsigned();
    t.text('send_error');
    t.bigInteger('sent_at');
    t.bigInteger('paid_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'number']);
    t.index(['tenant_id', 'id']);
  });
}

export async function down(knex) {
  await knex.schema.dropTable('sales_invoices');
}
