'use strict';

const db = require('./db');
const config = require('./config');
const net = require('./net');

const cache = new Set(config.seedTargets);
// userId -> último username que se mandó a la DB (evita updates repetidos)
const usernames = new Map();
let lastLoad = 0;
let inFlight = null;
let lastError = null;
let retryAt = 0;

const RETRY_MS = 30_000;

function seed() {
  for (const id of config.seedTargets) cache.add(id);
}

function warn(error) {
  if (error.code === 'not_configured') return;
  const message = error.code === 'network' ? net.describe(error) : error.message;
  if (message === lastError) return;
  lastError = message;
  console.error('[targets] no se pudo refrescar:', message);
}

/**
 * Recarga la lista de targets desde Supabase. Deduplicado: si ya hay un refresh
 * en vuelo, todos los llamadores esperan el mismo. Tras un fallo de red espera
 * 30s antes de volver a intentar para no martillar el gateway con la DB caída.
 */
function refresh({ force = false } = {}) {
  if (inFlight) return inFlight;

  inFlight = (async () => {
    if (!db.isConfigured()) {
      // Sin Supabase seguimos con los TARGETS del entorno, si hay.
      lastLoad = Date.now();
      lastError = null;
      return;
    }
    if (!force && Date.now() < retryAt) return;

    let response;
    try {
      response = await db.getClient().from('targets').select('user_id, username');
    } catch (error) {
      warn(error);
      retryAt = Date.now() + RETRY_MS;
      return;
    }

    const { data, error } = response;
    if (error) {
      warn(error);
      retryAt = Date.now() + RETRY_MS;
      return;
    }

    cache.clear();
    usernames.clear();
    for (const row of data || []) {
      cache.add(row.user_id);
      if (row.username) usernames.set(row.user_id, row.username);
    }
    seed();
    lastLoad = Date.now();
    lastError = null;
    retryAt = 0;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Sin TRACK_ALL, un usuario se loguea solo si está en la tabla targets.
 * La cache se refresca cada 20s para que agregar/quitar desde el dashboard
 * tenga efecto sin reiniciar el proceso.
 */
async function isTarget(userId) {
  if (config.trackAll) return true;
  if (Date.now() - lastLoad > 20_000) await refresh();
  return cache.has(userId);
}

/**
 * Mantiene el username del target al día sin escribir en cada evento: solo
 * cuando el nombre cambió respecto de lo último visto.
 */
async function touch(userId, username) {
  if (!userId || !username || username === 'desconocido') return;
  if (!cache.has(userId)) return;
  if (usernames.get(userId) === username) return;
  usernames.set(userId, username);
  if (!db.isConfigured()) return;

  try {
    const { error } = await db
      .getClient()
      .from('targets')
      .update({ username })
      .eq('user_id', userId);
    if (error) console.error('[targets] no se pudo actualizar el username:', error.message);
  } catch (error) {
    warn(error);
  }
}

async function add(userId, username, note) {
  if (!db.isConfigured()) {
    throw Object.assign(new Error('Configurá Supabase para guardar objetivos'), { code: 'not_configured' });
  }
  const row = { user_id: userId, username: username || null, note: note || null };
  const { error } = await db
    .getClient()
    .from('targets')
    .upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  cache.add(userId);
  if (username) usernames.set(userId, username);
  lastLoad = Date.now();
  retryAt = 0;
  lastError = null;
}

async function remove(userId) {
  const { error } = await db.getClient().from('targets').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
  cache.delete(userId);
  usernames.delete(userId);
}

async function list() {
  const { data, error } = await db
    .getClient()
    .from('targets')
    .select('user_id, username, note, created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

module.exports = {
  isTarget,
  add,
  remove,
  list,
  refresh,
  touch,
  status: () => ({ error: lastError, retryAt, size: cache.size }),
};
