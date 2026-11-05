import http from 'node:http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { db } from './db.js';
import { createApp } from './app.js';
import { setIO } from './lib/events.js';
import { verifyToken } from './lib/auth.js';
import { startWorker } from './lib/jobs.js';
import { ensureBillingJob } from './services/billing.js';
// register job handlers
import './whatsapp/inbound.js';
import './services/campaigns.js';
import './services/flows.js';

await db.migrate.latest({ directory: new URL('./migrations', import.meta.url).pathname, loadExtensions: ['.js'] });

const app = createApp();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.env === 'production' ? config.appUrl : true } });

io.use(async (socket, next) => {
  try {
    const payload = verifyToken(socket.handshake.auth?.token);
    const user = await db('users').where({ id: payload.sub, is_active: true }).first();
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  } catch { next(new Error('unauthorized')); }
});
io.on('connection', (socket) => {
  const u = socket.data.user;
  if (u.tenant_id) socket.join(`tenant:${u.tenant_id}`);
  if (u.role === 'superadmin') socket.join('superadmin');
  socket.join(`user:${u.id}`);
});
setIO(io);

if (process.env.WORKER !== 'false') {
  startWorker();
  await ensureBillingJob();
}

server.listen(config.port, () => {
  console.log(`[${config.brand}] API on :${config.port}  ·  webhook ${config.apiUrl}/webhooks/whatsapp`);
});

const shutdown = async () => { server.close(); await db.destroy(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
