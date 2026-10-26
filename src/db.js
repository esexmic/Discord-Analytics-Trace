'use strict';

const { createClient } = require('@supabase/supabase-js');
const settings = require('./settings');

/**
 * Cliente Supabase perezoso: se crea la primera vez que hace falta y se
 * reconstruye solo si cambian la URL o la key desde el panel. Sin credenciales
 * `getClient()` tira un error con code `not_configured`, que las rutas traducen
 * a 503 en vez de tirar el proceso.
 */

let override = null; // cliente falso de los tests
let client = null;
let clientKey = '';

function credentials() {
  const { supabaseUrl, supabaseKey } = settings.get();
  return { url: supabaseUrl, key: supabaseKey };
}

function isConfigured() {
  if (override) return true;
  const { url, key } = credentials();
  return Boolean(url && key);
}

function notConfigured() {
  return Object.assign(new Error('Supabase no está configurado'), { code: 'not_configured' });
}

function getClient() {
  if (override) return override;

  const { url, key } = credentials();
  if (!url || !key) throw notConfigured();

  const signature = `${url}|${key}`;
  if (!client || clientKey !== signature) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { 'x-application-name': 'watchtower' } },
    });
    clientKey = signature;
  }
  return client;
}

/** Descarta el cliente cacheado (cambio de credenciales o error de conexión). */
function reset() {
  client = null;
  clientKey = '';
}

/**
 * Inserta un lote de eventos y devuelve las filas creadas (con id y created_at
 * reales) para poder empujarlas al dashboard por SSE.
 */
async function insertEvents(rows) {
  if (!rows.length) return [];
  const { data, error } = await getClient().from('events').insert(rows).select();
  if (error) throw new Error(error.message);
  return data || [];
}

function __setClient(fake) {
  override = fake;
  if (!fake) reset();
}

module.exports = { getClient, isConfigured, reset, insertEvents, __setClient };
