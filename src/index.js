'use strict';

const { startServer } = require('./server');
const bot = require('./bot');
const queue = require('./queue');
const db = require('./db');
const webhooks = require('./webhooks');

const server = startServer();
let stopping = false;

async function boot() {
  const result = await db.init();
  if (!result.ok) {
    console.error(`[db] ${result.code || 'db_unavailable'}: ${result.message}`);
    console.error('[db] el panel arranca igual; revisá la configuración y reiniciá el deploy');
  } else {
    console.log(`[db] Supabase OK${result.source ? ` (${result.source})` : ''}`);
  }

  try {
    const count = await bot.startAll();
    if (count) console.log(`[bot] ${count} cuenta(s) con token para conectar`);
  } catch (error) {
    console.error('[bot] no se pudieron reconectar las cuentas:', error.message);
  }
}

void boot().catch((error) => {
  console.error('[app] arranque incompleto:', error.message);
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[app] ${signal} recibido, cerrando limpio...`);

  try {
    await bot.stopAll();
  } catch {
    // los gateways ya estaban caídos
  }

  try {
    const pending = await queue.drain(4000);
    if (pending) console.warn(`[app] quedaron ${pending} eventos sin escribir`);
  } catch {
    // Ya estamos saliendo: no hay nada mejor que hacer.
  }

  try {
    await webhooks.drain(2000);
  } catch {
    // el webhook se pierde; la escritura a la base ya intentó lo suyo
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[app] unhandled rejection:', reason);
});
