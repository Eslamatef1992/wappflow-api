// Arabic description for plans (shown to customers using the Arabic interface).
export async function up(knex) {
  await knex.schema.alterTable('plans', (t) => { t.text('description_ar'); });
}
export async function down(knex) {
  await knex.schema.alterTable('plans', (t) => { t.dropColumn('description_ar'); });
}
