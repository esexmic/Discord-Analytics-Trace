'use strict';

const { startServer } = require('./server');
const { startBot, stopBot } = require('./bot');
const queue = require('./queue');
const settings = require('./settings');
const db = require('./db');

const server = startServer();
let stopping = false;

async function bootBot(attempt = 1) {
  const { discordToken } = settings.get();

  if (!discordToken) {
    console.log('[bot] sin token de Discord: abrí el panel y pegalo en Ajustes → Discord');
    return;
  }

  try {
    await startBot();
  } catch (error) {
    console.error(`[bot] intento ${attempt} falló:`, error.message);
    if (error.code === 'invalid_token') {
      console.error('[bot] el token no sirve: pegalo de nuevo desde el panel');
      return;
    }
    if (attempt >= 5) {
      console.error('[bot] no se pudo conectar después de 5 intentos, revisá el token');
      process.exitCode = 1;
      return;
    }
    const delay = Math.min(60_000, 5_000 * attempt);
    console.log(`[bot] reintento en ${Math.round(delay / 1000)}s...`);
    setTimeout(() => void bootBot(attempt + 1), delay).unref?.();
  }
}

if (!db.isConfigured()) {
  console.log('[app] Supabase sin configurar: el panel arranca en modo setup');
}

// Sin ACCESS_KEY la key de registro vive en el disco (efímero en Railway).
// Dejarla en el log permite crear la primera cuenta aunque el panel todavía
// no tenga admin. Con ACCESS_KEY definida no se imprime nada.
if (!process.env.ACCESS_KEY && !process.env.REGISTRATION_KEY) {
  console.log(`[auth] key de acceso para crear cuentas: ${settings.registrationKey()}`);
}

void bootBot();

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[app] ${signal} recibido, cerrando limpio...`);

  try {
    await stopBot();
  } catch {
    // el gateway ya estaba caído
  }

  try {
    const pending = await queue.drain(4000);
    if (pending) console.warn(`[app] quedaron ${pending} eventos sin escribir`);
  } catch {
    // Ya estamos saliendo: no hay nada mejor que hacer.
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[app] unhandled rejection:', reason);
});
