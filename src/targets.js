'use strict';

const db = require('./db');
const config = require('./config');
const net = require('./net');

/**
 * Objetivos por cuenta del panel. Cada fila de `targets` lleva `owner` (el
 * username del panel), así dos usuarios de la web pueden vigilar al mismo
 * Discord sin pisarse.
 *
 * La cache vive en memoria por owner y se refresca cada 20s para que el bot
 * vea al instante lo que se agrega o quita desde el panel. Los targets del
 * entorno (TARGETS) se suman a todos los owner.
 */

const CACHE_MS = 20_000;
const RETRY_MS = 30_000;

/** owner -> { ids, usernames, lastLoad, retryAt, lastError, inFlight } */
const states = new Map();

function state(owner) {
  let entry = states.get(owner);
  if (!entry) {
    entry = {
      ids: new Set(),
      usernames: new Map(),
      lastLoad: 0,
      retryAt: 0,
      lastError: null,
      inFlight: null,
    };
    states.set(owner, entry);
  }
  return entry;
}

function warn(entry, error) {
  if (error?.code === 'not_configured') return;
  const message = error?.code === 'network' ? net.describe(error) : error?.message || String(error);
  if (message === entry.lastError) return;
  entry.lastError = message;
  console.error('[targets] no se pudo refrescar:', message);
}

function refresh(owner, { force = false } = {}) {
  const entry = state(owner);
  if (entry.inFlight) return entry.inFlight;

  entry.inFlight = (async () => {
    if (!db.isConfigured()) {
      entry.lastLoad = Date.now();
      entry.lastError = null;
      return;
    }
    if (!db.isHealthy()) return;
    if (!force && Date.now() < entry.retryAt) return;

    let response;
    try {
      response = await db
        .getClient()
        .from('targets')
        .select('user_id, username')
        .eq('owner', owner);
    } catch (error) {
      warn(entry, error);
      entry.retryAt = Date.now() + RETRY_MS;
      return;
    }

    if (response.error) {
      db.noteFailure(response.error);
      warn(entry, response.error);
      entry.retryAt = Date.now() + RETRY_MS;
      return;
    }

    entry.ids.clear();
    entry.usernames.clear();
    for (const row of response.data || []) {
      entry.ids.add(String(row.user_id));
      if (row.username) entry.usernames.set(String(row.user_id), row.username);
    }
    entry.lastLoad = Date.now();
    entry.lastError = null;
    entry.retryAt = 0;
  })().finally(() => {
    entry.inFlight = null;
  });

  return entry.inFlight;
}

/** Sin TRACK_ALL, un usuario se loguea solo si está en los targets del owner. */
async function isTarget(owner, userId) {
  if (config.trackAll) return true;
  const id = String(userId);
  if (config.seedTargets.includes(id)) return true;

  const entry = state(owner);
  if (Date.now() - entry.lastLoad > CACHE_MS) await refresh(owner);
  return entry.ids.has(id);
}

/** Mantiene el username al día sin escribir en cada evento. */
async function touch(owner, userId, username) {
  if (!userId || !username || username === 'desconocido') return;
  const entry = state(owner);
  const id = String(userId);
  if (!entry.ids.has(id) && !config.seedTargets.includes(id)) return;
  if (entry.usernames.get(id) === username) return;
  entry.usernames.set(id, username);
  if (!db.isConfigured() || !db.isHealthy()) return;

  try {
    const { error } = await db
      .getClient()
      .from('targets')
      .update({ username })
      .eq('owner', owner)
      .eq('user_id', id);
    if (error) {
      db.noteFailure(error);
      console.error('[targets] no se pudo actualizar el username:', error.message);
    }
  } catch (error) {
    warn(entry, error);
  }
}

async function add(owner, userId, username, note) {
  if (!db.isConfigured()) {
    throw Object.assign(
      new Error('La base no está configurada: revisá SUPABASE_URL y la service key del deploy'),
      { code: 'not_configured' }
    );
  }
  const id = String(userId);
  const row = { owner, user_id: id, username: username || null, note: note || null };
  const { error } = await db
    .getClient()
    .from('targets')
    .upsert(row, { onConflict: 'owner,user_id' });
  if (error) {
    db.noteFailure(error);
    throw Object.assign(new Error(error.message), { code: 'io' });
  }

  const entry = state(owner);
  entry.ids.add(id);
  if (username) entry.usernames.set(id, username);
  entry.lastLoad = Date.now();
  entry.retryAt = 0;
  entry.lastError = null;
}

async function remove(owner, userId) {
  const id = String(userId);
  const { error } = await db
    .getClient()
    .from('targets')
    .delete()
    .eq('owner', owner)
    .eq('user_id', id);
  if (error) {
    db.noteFailure(error);
    throw Object.assign(new Error(error.message), { code: 'io' });
  }
  const entry = state(owner);
  entry.ids.delete(id);
  entry.usernames.delete(id);
}

async function list(owner) {
  const { data, error } = await db
    .getClient()
    .from('targets')
    .select('user_id, username, note, created_at')
    .eq('owner', owner)
    .order('created_at', { ascending: false });
  if (error) {
    db.noteFailure(error);
    throw Object.assign(new Error(error.message), { code: 'io' });
  }
  return data || [];
}

function status() {
  let size = 0;
  let error = null;
  for (const entry of states.values()) {
    size += entry.ids.size;
    if (entry.lastError) error = entry.lastError;
  }
  return { error, size };
}

function reset() {
  states.clear();
}

/** Tira la cache de una cuenta (la usa el admin al borrarla). */
function forget(owner) {
  states.delete(String(owner || '').trim().toLowerCase());
}

module.exports = {
  isTarget,
  add,
  remove,
  list,
  refresh,
  touch,
  status,
  reset,
  forget,
};
