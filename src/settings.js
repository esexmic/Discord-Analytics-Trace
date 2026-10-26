'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Configuración de infraestructura. Ya no se edita desde el panel: Supabase y
 * el secreto de sesión vienen del entorno del deploy. El token de Discord es
 * de cada cuenta y vive en la tabla `accounts`, no acá.
 *
 * Precedencia: variables de entorno > data/settings.json (compatibilidad con
 * instalaciones viejas). La cuenta legacy del deploy (DASHBOARD_USERNAME /
 * DASHBOARD_PASSWORD) se mantiene solo para migrar al admin existente.
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const SUPABASE_URL_VARS = ['SUPABASE_URL', 'SUPABASE_PROJECT_URL', 'NEXT_PUBLIC_SUPABASE_URL'];
const SUPABASE_KEY_VARS = [
  'SUPABASE_SERVICE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_SECRET_KEY',
  'SUPABASE_KEY',
];

let stored = {};
let account = null;
let loaded = false;
let sessionSecretCache = '';

/* ------------------------------------------------------------------ archivo */

function load() {
  if (loaded) return;
  loaded = true;

  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      stored = parsed.values && typeof parsed.values === 'object' ? parsed.values : {};

      if (parsed.account && parsed.account.hash) {
        account = {
          username: String(parsed.account.username || 'admin').toLowerCase(),
          salt: String(parsed.account.salt || ''),
          hash: String(parsed.account.hash || ''),
        };
      } else if (parsed.password && parsed.password.hash) {
        account = {
          username: 'admin',
          salt: String(parsed.password.salt || ''),
          hash: String(parsed.password.hash || ''),
        };
      }

      if (typeof stored.sessionSecret === 'string' && stored.sessionSecret.length >= 32) {
        sessionSecretCache = stored.sessionSecret;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[settings] no se pudo leer data/settings.json:', error.message);
    }
    stored = {};
    account = null;
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const payload = JSON.stringify(
    {
      version: 3,
      updated_at: new Date().toISOString(),
      values: stored,
      account,
    },
    null,
    2
  );
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/* -------------------------------------------------------------- credenciales */

/** Copiar/pegar desde un panel suele arrastrar comillas o saltos. */
function strip(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

/** Acepta la URL del proyecto con o sin /rest/v1 y sin barra final. */
function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Rechaza claves públicas y JWT que no sean service_role. Las claves nuevas
 * `sb_secret_…` se aceptan directo. Esto evita arrancar con la anon key por
 * error y perder horas mirando "permission denied".
 */
function keyLooksUsable(key) {
  const raw = strip(key);
  if (!raw || raw.length < 20) return false;
  if (raw.startsWith('sb_publishable_') || raw.startsWith('sb_anon')) return false;
  if (!raw.startsWith('eyJ')) return true;

  try {
    const payload = JSON.parse(Buffer.from(raw.split('.')[1] || '', 'base64url').toString('utf8'));
    if (payload.role && payload.role !== 'service_role') return false;
  } catch {
    // JWT raro: que decida la prueba real contra Supabase.
  }
  return true;
}

/**
 * Combinaciones URL + key a probar al arrancar. Railway puede tener la key
 * buena en `SUPABASE_KEY` y una vieja en `SUPABASE_SERVICE_KEY`; probar todas
 * y quedarse con la que responde es lo que corta el "Invalid API key".
 */
function supabaseCandidates() {
  load();

  const urls = [];
  for (const name of SUPABASE_URL_VARS) {
    const value = normalizeUrl(strip(process.env[name]));
    if (value && !urls.includes(value)) urls.push(value);
  }
  const storedUrl = normalizeUrl(strip(stored.supabaseUrl));
  if (storedUrl && !urls.includes(storedUrl)) urls.push(storedUrl);

  const keys = [];
  for (const name of SUPABASE_KEY_VARS) {
    const value = strip(process.env[name]);
    if (keyLooksUsable(value) && !keys.includes(value)) keys.push(value);
  }
  const storedKey = strip(stored.supabaseKey);
  if (keyLooksUsable(storedKey) && !keys.includes(storedKey)) keys.push(storedKey);

  const out = [];
  const seen = new Set();
  for (const url of urls) {
    for (const key of keys) {
      const signature = `${url}|${key}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      out.push({ url, key, source: envKeySource(url, key) });
    }
  }
  return out;
}

function envKeySource(url, key) {
  for (const name of SUPABASE_URL_VARS) {
    if (normalizeUrl(strip(process.env[name])) !== url) continue;
    for (const keyName of SUPABASE_KEY_VARS) {
      if (strip(process.env[keyName]) === key) return `${keyName}@${name}`;
    }
  }
  return 'data/settings.json';
}

/** Primera combinación disponible; el módulo db resuelve la que funciona. */
function get() {
  const [first] = supabaseCandidates();
  return {
    supabaseUrl: first?.url || '',
    supabaseKey: first?.key || '',
  };
}

/* ------------------------------------------------------------------ cuenta */

function timingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function derive(plain, salt) {
  return crypto.scryptSync(String(plain), salt, 64).toString('hex');
}

function envPassword() {
  return String(process.env.DASHBOARD_PASSWORD || '').trim();
}

function envUsername() {
  return String(process.env.DASHBOARD_USERNAME || 'admin').trim().toLowerCase() || 'admin';
}

function hasAccount() {
  load();
  if (envPassword()) return true;
  return Boolean(account);
}

function accountView() {
  load();
  if (envPassword()) return { username: envUsername(), source: 'env' };
  if (account) return { username: account.username, source: 'file' };
  return { username: '', source: 'none' };
}

function verifyAccount(username, plain) {
  load();
  const password = envPassword();
  if (password) {
    return timingEqual(String(username ?? '').trim().toLowerCase(), envUsername())
      && timingEqual(String(plain ?? ''), password);
  }
  if (!account) return false;
  if (!timingEqual(String(username ?? '').trim().toLowerCase(), account.username)) return false;
  return timingEqual(derive(plain, account.salt), account.hash);
}

/* ---------------------------------------------------------- session secret */

function sessionSecret() {
  load();
  const env = String(process.env.SESSION_SECRET || '').trim();
  if (env) return env;
  if (sessionSecretCache) return sessionSecretCache;

  sessionSecretCache = crypto.randomBytes(32).toString('hex');
  stored.sessionSecret = sessionSecretCache;
  try {
    persist();
  } catch {
    // Disco efímero o de solo lectura: las sesiones duran lo que el proceso.
  }
  return sessionSecretCache;
}

/* ------------------------------------------------------------------- reset */

/** Solo para tests: vuelve a leer el archivo y el entorno. */
function __reload() {
  loaded = false;
  stored = {};
  account = null;
  sessionSecretCache = '';
  load();
}

module.exports = {
  get,
  supabaseCandidates,
  strip,
  normalizeUrl,
  keyLooksUsable,
  accountView,
  hasAccount,
  verifyAccount,
  sessionSecret,
  DATA_DIR,
  FILE,
  __reload,
};
