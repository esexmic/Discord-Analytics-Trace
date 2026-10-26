'use strict';

const { createClient } = require('@supabase/supabase-js');
const settings = require('./settings');
const net = require('./net');

/**
 * Cliente Supabase perezoso: se crea la primera vez que hace falta y se
 * reconstruye solo si cambian la URL o la key desde el panel. Sin credenciales
 * `getClient()` tira un error con code `not_configured`, que las rutas traducen
 * a 503 en vez de tirar el proceso.
 *
 * El fetch del cliente pasa por src/net.js: deadline de 12s y un reintento
 * cuando la conexión todavía no se estableció. Eso cubre los `fetch failed`
 * intermitentes de Railway sin duplicar inserts.
 */

let override = null; // cliente falso de los tests
let client = null;
let clientKey = '';

function credentials() {
  const { supabaseUrl, supabaseKey } = settings.get();
  return { url: supabaseUrl, key: supabaseKey };
}

/** Devuelve un problema legible o null si las credenciales tienen forma válida. */
function credentialProblem(url, key) {
  if (!url || !key) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'SUPABASE_URL no es una URL válida';
  }
  if (parsed.protocol !== 'https:') return 'SUPABASE_URL tiene que empezar con https://';
  if (parsed.hostname.startsWith('db.') || parsed.hostname.includes('pooler')) {
    return 'SUPABASE_URL apunta a la base de datos directa; usá la Project URL (https://<ref>.supabase.co)';
  }
  if (key.length < 20) return 'SUPABASE_SERVICE_KEY es demasiado corta';
  return null;
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

  const problem = credentialProblem(url, key);
  if (problem) {
    throw Object.assign(new Error(problem), { code: 'invalid_config' });
  }

  const signature = `${url}|${key}`;
  if (!client || clientKey !== signature) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { 'x-application-name': 'xyb' },
        fetch: (input, init) => net.fetchWithRetry(input, init, {
          retries: 1,
          timeoutMs: 12_000,
          label: 'supabase',
        }),
      },
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
 * Prueba real contra la tabla targets. Se usa al guardar credenciales y en el
 * diagnóstico del panel. Nunca tira: devuelve { ok, message }.
 */
async function probeCredentials(url, key, timeoutMs = 15_000) {
  if (!url || !key) return { ok: false, message: 'Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY' };

  const problem = credentialProblem(url, key);
  if (problem) return { ok: false, message: problem };

  try {
    const response = await net.fetchWithRetry(`${url}/rest/v1/targets?select=user_id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }, { retries: 2, timeoutMs, label: 'supabase-probe' });

    if (response.status === 200) {
      return { ok: true, message: 'Conexión OK, tabla targets visible' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: 'La secret key fue rechazada' };
    }
    if (response.status === 404) {
      const body = await response.text();
      return /relation|does not exist|42P01/i.test(body)
        ? { ok: false, message: 'Falta correr schema.sql en Supabase' }
        : { ok: false, message: `Supabase respondió ${response.status}` };
    }
    const body = (await response.text()).slice(0, 200);
    return { ok: false, message: `Supabase respondió ${response.status}: ${body}` };
  } catch (error) {
    return { ok: false, message: `No se pudo llegar a Supabase: ${net.describe(error)}`, code: 'network' };
  }
}

async function probe(timeoutMs = 15_000) {
  const { url, key } = credentials();
  return probeCredentials(url, key, timeoutMs);
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

module.exports = {
  getClient,
  isConfigured,
  reset,
  insertEvents,
  probe,
  probeCredentials,
  credentialProblem,
  __setClient,
};
