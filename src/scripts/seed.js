// Usage: npm run seed            → plans + super admin
//        npm run seed -- --demo  → also a demo workspace with a mock number, contacts, templates and a chatbot
import bcrypt from 'bcryptjs';
import { db, s, now, insert } from '../db.js';
import { startTrial } from '../services/billing.js';

const demo = process.argv.includes('--demo');

await db.migrate.latest({ directory: new URL('../migrations', import.meta.url).pathname, loadExtensions: ['.js'] });

const PLANS = [
  { name: 'Starter', slug: 'starter', price_monthly: 15, price_yearly: 150, sort: 1, description: 'For small shops getting started on WhatsApp',
    limits: { contacts: 1000, monthly_messages: 2000, agents: 2, numbers: 1, flows: 2 }, features: { campaigns: true, inbox: true, flows: true, commerce: false, api: false } },
  { name: 'Growth', slug: 'growth', price_monthly: 35, price_yearly: 350, sort: 2, description: 'Campaigns, chatbots and store automations',
    limits: { contacts: 10000, monthly_messages: 20000, agents: 5, numbers: 2, flows: 10 }, features: { campaigns: true, inbox: true, flows: true, commerce: true, api: true } },
  { name: 'Business', slug: 'business', price_monthly: 79, price_yearly: 790, sort: 3, description: 'Unlimited scale for busy teams',
    limits: { contacts: -1, monthly_messages: 100000, agents: 20, numbers: 5, flows: -1 }, features: { campaigns: true, inbox: true, flows: true, commerce: true, api: true } },
];

for (const p of PLANS) {
  if (!(await db('plans').where({ slug: p.slug }).first())) {
    await insert('plans', { ...p, currency: 'KWD', limits: s(p.limits), features: s(p.features), is_active: true, created_at: now() });
    console.log(`plan: ${p.name}`);
  }
}

const adminEmail = (process.env.ADMIN_EMAIL || 'admin@wasla.local').toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || 'admin12345';
if (!(await db('users').where({ email: adminEmail }).first())) {
  await insert('users', { tenant_id: null, name: 'Platform Admin', email: adminEmail, role: 'superadmin', is_active: true, password_hash: await bcrypt.hash(adminPassword, 10), created_at: now() });
  console.log(`super admin: ${adminEmail} / ${adminPassword}  (change it!)`);
}

if (demo && !(await db('tenants').where({ slug: 'demo-store' }).first())) {
  const growth = await db('plans').where({ slug: 'growth' }).first();
  const tid = await insert('tenants', { name: 'Demo Store', slug: 'demo-store', status: 'trial', plan_id: growth.id, created_at: now() });
  await startTrial(tid, growth.id);
  await insert('users', { tenant_id: tid, name: 'Demo Owner', email: 'owner@demo.local', role: 'owner', is_active: true, password_hash: await bcrypt.hash('demo12345', 10), created_at: now() });
  await insert('users', { tenant_id: tid, name: 'Sara (Agent)', email: 'agent@demo.local', role: 'agent', is_active: true, password_hash: await bcrypt.hash('demo12345', 10), created_at: now() });
  await insert('wa_numbers', { tenant_id: tid, label: 'Demo number', display_phone: '+965 5000 0000', phone_number_id: `mock-${tid}-demo`, waba_id: `mock-waba-${tid}`, mode: 'mock', status: 'connected', quality_rating: 'GREEN', is_default: true, created_at: now() });

  const vip = await insert('tags', { tenant_id: tid, name: 'VIP', color: '#a855f7' });
  const leads = await insert('tags', { tenant_id: tid, name: 'Leads', color: '#0ea5e9' });
  const people = [
    ['96550010001', 'Ahmad Al-Sabah', vip, { city: 'Kuwait City' }], ['96550010002', 'Fatima Hassan', vip, { city: 'Salmiya' }],
    ['96550010003', 'Yousef Ali', leads, { city: 'Hawalli' }], ['96550010004', 'Noura Khaled', leads, { city: 'Jabriya' }],
    ['96550010005', 'Omar Saleh', leads, { city: 'Farwaniya' }], ['96550010006', 'Mariam Adel', null, { city: 'Fintas' }],
  ];
  for (const [wa_id, name, tag, attrs] of people) {
    const cid = await insert('contacts', { tenant_id: tid, wa_id, name, attributes: s(attrs), opted_in: true, source: 'import', created_at: now() });
    if (tag) await db('contact_tags').insert({ contact_id: cid, tag_id: tag });
  }

  const T = (name, category, components, language = 'en') => insert('templates', { tenant_id: tid, name, language, category, status: 'APPROVED', components: s(components), created_at: now(), updated_at: now() });
  await T('welcome_offer', 'MARKETING', [
    { type: 'HEADER', format: 'TEXT', text: 'Weekend offer 🎉' },
    { type: 'BODY', text: 'Hi {{1}}, enjoy {{2}} off everything this weekend. Show this message in store or order online.' },
    { type: 'FOOTER', text: 'Reply STOP to unsubscribe' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Shop now' }, { type: 'QUICK_REPLY', text: 'Not interested' }] },
  ]);
  await T('order_confirmation', 'UTILITY', [{ type: 'BODY', text: 'Thank you {{1}}! Your order {{2}} for {{3}} is confirmed. We will message you when it ships.' }]);
  await T('order_shipped', 'UTILITY', [{ type: 'BODY', text: 'Good news {{1}}, order {{2}} is on its way 🚚' }]);
  await T('welcome_offer_ar', 'MARKETING', [{ type: 'BODY', text: 'مرحباً {{1}}، استمتع بخصم {{2}} على جميع المنتجات هذا الأسبوع.' }], 'ar');

  const conf = await db('templates').where({ tenant_id: tid, name: 'order_confirmation' }).first();
  await insert('automations', { tenant_id: tid, event: 'order.created', template_id: conf.id, is_active: true, variables: s({ body: [{ source: 'field', value: 'contact.first_name' }, { source: 'field', value: 'order.number' }, { source: 'field', value: 'order.total' }] }) });

  await insert('flows', {
    tenant_id: tid, name: 'Welcome menu', trigger_type: 'keyword', trigger_value: 'hi,hello,menu,مرحبا,السلام عليكم', is_active: true, created_at: now(), updated_at: now(),
    graph: s({
      nodes: [
        { id: 'start', type: 'start', position: { x: 40, y: 200 }, data: { label: 'Start' } },
        { id: 'menu', type: 'buttons', position: { x: 300, y: 160 }, data: { label: 'Main menu', text: 'Hi {{contact.first_name}} 👋 Welcome to Demo Store. What would you like to do?', buttons: [{ id: 'b1', title: 'Browse offers' }, { id: 'b2', title: 'Track my order' }, { id: 'b3', title: 'Talk to an agent' }] } },
        { id: 'offers', type: 'message', position: { x: 680, y: 20 }, data: { label: 'Offers', text: 'This week: 20% off all perfumes 🌸 Reply "menu" anytime to see options again.' } },
        { id: 'askorder', type: 'question', position: { x: 680, y: 200 }, data: { label: 'Ask order no.', text: 'Please type your order number:', variable: 'order_no', saveTo: 'last_order_no' } },
        { id: 'tellorder', type: 'message', position: { x: 1020, y: 200 }, data: { label: 'Order reply', text: 'Thanks! Order {{vars.order_no}} is being prepared and will ship within 24 hours.' } },
        { id: 'tag', type: 'tag', position: { x: 680, y: 380 }, data: { label: 'Tag lead', tag: 'Needs agent' } },
        { id: 'agent', type: 'assign', position: { x: 1020, y: 380 }, data: { label: 'Hand over', text: 'Connecting you with our team now 🙌' } },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'menu' },
        { id: 'e2', source: 'menu', sourceHandle: 'b1', target: 'offers' },
        { id: 'e3', source: 'menu', sourceHandle: 'b2', target: 'askorder' },
        { id: 'e4', source: 'askorder', target: 'tellorder' },
        { id: 'e5', source: 'menu', sourceHandle: 'b3', target: 'tag' },
        { id: 'e6', source: 'tag', target: 'agent' },
      ],
    }),
  });
  await insert('quick_replies', { tenant_id: tid, shortcut: 'hours', body: 'We are open Saturday–Thursday, 10am–10pm.' });
  await insert('quick_replies', { tenant_id: tid, shortcut: 'thanks', body: 'Thank you for contacting us! Anything else we can help with?' });
  await insert('products', { tenant_id: tid, name: 'Oud Royal 100ml', price: 24.5, currency: 'KWD', sku: 'OUD-100', retailer_id: 'OUD-100', is_active: true, created_at: now() });
  await insert('products', { tenant_id: tid, name: 'Rose Musk 50ml', price: 12, currency: 'KWD', sku: 'RM-50', retailer_id: 'RM-50', is_active: true, created_at: now() });
  console.log('demo workspace: owner@demo.local / demo12345 (agent@demo.local / demo12345)');
}

await db.destroy();
