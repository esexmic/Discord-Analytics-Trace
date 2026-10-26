'use strict';

const { createClient } = require('@supabase/supabase-js');
const settings = require('./settings');
const net = require('./net');

/**
 * Cliente Supabase perezoso con resolución de credenciales.
 *
 * El arranque prueba todas las combinaciones URL/key del entorno y se queda
 * con la que responde. Eso resuelve el caso típico de Railway: una
 * `SUPABASE_SERVICE_KEY` vieja conviviendo con la key buena en otra variable.
 *
 * Si la key elegida empieza a ser rechazada ("Invalid API key"), se marca el
 * problema, se corta el cliente y se reintenta la resolución como mucho una
 * vez por minuto. Mientras tanto las rutas fallan rápido con un mensaje claro
 * en vez de martillar la API.
 */

let override = null; // cliente falso de los tests
let client = null;
let clientKey = '';
let resolved = null;
let problem = null;
let initializing = null;
let lastInit = 0;
let reinitAt = 0;
let probeCache = null;

const RETRY_RESOLVE_MS = 60_000;
const PROBE_CACHE_MS = 30_000;

function candidates() {
  return settings.supabaseCandidates();
}

function credentials() {
  return resolved || candidates()[0] || { url: '', key: '', source: '' };
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
    return 'SUPABASE_URL apunta a la base directa; usá la Project URL (https://<ref>.supabase.co)';
  }
  if (key.length < 20) return 'La service key de Supabase es demasiado corta';
  return null;
}

function isConfigured() {
  if (override) return true;
  return candidates().length > 0;
}

function isHealthy() {
  if (override) return true;
  return !problem;
}

function problemView() {
  if (override) return null;
  return problem ? { code: problem.code || 'db_unavailable', message: problem.message } : null;
}

function notConfigured() {
  return Object.assign(new Error('La base no está configurada (falta SUPABASE_URL / service key)'), {
    code: 'not_configured',
  });
}

function getClient() {
  if (override) return override;

  const { url, key, source } = credentials();
  if (!url || !key) throw notConfigured();

  // Key rechazada: no tiene sentido intentar hasta el próximo reintento.
  if (problem?.code === 'invalid_config' && Date.now() < reinitAt) {
    throw Object.assign(new Error(problem.message), { code: 'invalid_config' });
  }

  const shape = credentialProblem(url, key);
  if (shape) throw Object.assign(new Error(shape), { code: 'invalid_config' });

  const signature = `${url}|${key}`;
  if (!client || clientKey !== signature) {
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { 'x-application-name': 'trace-xyb' },
        fetch: (input, init) => net.fetchWithRetry(input, init, {
          retries: 1,
          timeoutMs: 12_000,
          label: 'supabase',
        }),
      },
    });
    clientKey = signature;
    resolved = { url, key, source: source || resolved?.source || 'env' };
  }
  return client;
}

function reset() {
  client = null;
  clientKey = '';
}

/**
 * Prueba una combinación concreta. Nunca tira: devuelve { ok, message, code }.
 * El código permite distinguir key inválida de tabla faltante.
 */
async function probeCredentials(url, key, timeoutMs = 10_000) {
  if (!url || !key) {
    return { ok: false, code: 'not_configured', message: 'Faltan SUPABASE_URL o la service key' };
  }

  const shape = credentialProblem(url, key);
  if (shape) return { ok: false, code: 'invalid_config', message: shape };

  try {
    const response = await net.fetchWithRetry(`${url}/rest/v1/targets?select=user_id&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }, { retries: 1, timeoutMs, label: 'supabase-probe' });

    if (response.status === 200) {
      return { ok: true, message: 'Conexión OK' };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        code: 'invalid_config',
        message: 'Supabase rechazó la service key ("Invalid API key"). Revisá el valor en el entorno del deploy.',
      };
    }
    if (response.status === 404) {
      const body = await response.text();
      if (/relation|does not exist|42P01/i.test(body)) {
        return {
          ok: false,
          code: 'schema',
          message: 'La service key funciona, pero falta correr schema.sql (no existe la tabla targets).',
        };
      }
      return { ok: false, code: 'invalid_config', message: `Supabase respondió 404: ${body.slice(0, 160)}` };
    }
    const body = (await response.text()).slice(0, 200);
    return { ok: false, code: 'db_unavailable', message: `Supabase respondió ${response.status}: ${body}` };
  } catch (error) {
    return {
      ok: false,
      code: 'network',
      message: `No se pudo llegar a Supabase: ${net.describe(error)}`,
    };
  }
}

/**
 * Resuelve credenciales. Probar una key cuesta un request chico; se hace una
 * sola vez por proceso (o cuando algo falla), no por request.
 */
function init({ force = false } = {}) {
  if (override) {
    problem = null;
    return Promise.resolve({ ok: true, message: 'cliente de test' });
  }
  if (initializing) return initializing;
  if (!force && lastInit && Date.now() - lastInit < RETRY_RESOLVE_MS) {
    return Promise.resolve({
      ok: !problem,
      code: problem?.code,
      message: problem?.message || 'credenciales ya resueltas',
      source: resolved?.source || null,
    });
  }

  initializing = (async () => {
    const list = candidates();
    if (!list.length) {
      resolved = null;
      problem = { code: 'not_configured', message: 'Faltan SUPABASE_URL y la service key' };
      lastInit = Date.now();
      return { ok: false, ...problem };
    }

    let lastRejection = null;
    for (const candidate of list) {
      const result = await probeCredentials(candidate.url, candidate.key);
      if (result.ok) {
        resolved = candidate;
        problem = null;
        reset();
        lastInit = Date.now();
        reinitAt = 0;
        return { ok: true, message: result.message, source: candidate.source };
      }

      // La key sirve pero falta el schema o la red está caída: no tiene sentido
      // seguir probando otras keys del mismo proyecto.
      if (result.code === 'schema' || result.code === 'network') {
        resolved = candidate;
        problem = { code: result.code, message: result.message };
        reset();
        lastInit = Date.now();
        return { ok: false, ...problem };
      }
      lastRejection = result;
    }

    resolved = list[0];
    problem = {
      code: lastRejection?.code || 'invalid_config',
      message: lastRejection?.message || 'No se pudo validar la conexión con Supabase',
    };
    reset();
    lastInit = Date.now();
    return { ok: false, ...problem };
  })().finally(() => {
    initializing = null;
  });

  return initializing;
}

/**
 * Registra un fallo de consulta. Si es de credenciales, invalida lo resuelto y
 * programa una nueva resolución sin entrar en loop.
 */
function noteFailure(error) {
  if (override) return;
  const text = String(error?.message || error || '');
  const code = String(error?.code || '');

  if (code === 'network' || /fetch failed|timeout|ENOTFOUND|EAI_AGAIN|ECONNRESET/i.test(text)) {
    problem = { code: 'network', message: `La base no responde: ${net.describe(error)}` };
    return;
  }

  if (/invalid api key|jwt|401|403|permission denied|row-level security/i.test(text)) {
    problem = {
      code: 'invalid_config',
      message: 'Supabase rechazó la service key. Revisá SUPABASE_SERVICE_KEY (o SUPABASE_KEY) en el entorno del deploy.',
    };
    resolved = null;
    reset();
    if (Date.now() >= reinitAt) {
      reinitAt = Date.now() + RETRY_RESOLVE_MS;
      void init({ force: true });
    }
    return;
  }

  if (/does not exist|relation|42P01|schema/i.test(text)) {
    problem = {
      code: 'schema',
      message: 'Falta correr schema.sql: la base no tiene las tablas o columnas nuevas.',
    };
  }
}

/** Estado de la base para /health y el panel. Cacheado para no castigar la API. */
async function probe(timeoutMs = 10_000) {
  if (override) return { ok: true, message: 'cliente de test' };
  if (probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.value;

  const { url, key } = credentials();
  const value = await probeCredentials(url, key, timeoutMs);
  probeCache = { at: Date.now(), value };
  if (!value.ok) {
    problem = { code: value.code || 'db_unavailable', message: value.message };
  } else {
    problem = null;
  }
  return value;
}

/**
 * Inserta un lote de eventos y devuelve las filas creadas (con id y created_at
 * reales) para empujarlas al dashboard por SSE.
 */
async function insertEvents(rows) {
  if (!rows.length) return [];
  const { data, error } = await getClient().from('events').insert(rows).select();
  if (error) {
    noteFailure(error);
    throw Object.assign(new Error(error.message), { code: 'io' });
  }
  return data || [];
}

function __setClient(fake) {
  override = fake || null;
  if (fake) {
    problem = null;
    probeCache = null;
  } else {
    reset();
    resolved = null;
    problem = null;
    lastInit = 0;
    reinitAt = 0;
    probeCache = null;
  }
}

module.exports = {
  getClient,
  isConfigured,
  isHealthy,
  problemView,
  init,
  noteFailure,
  reset,
  insertEvents,
  probe,
  probeCredentials,
  credentialProblem,
  __setClient,
};
