'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Configuración en caliente. Los valores pueden venir de variables de entorno
 * (deploy en Railway) o de data/settings.json (lo que se carga desde el panel).
 *
 * Precedencia: entorno > archivo. Si una variable está definida, el panel la
 * muestra bloqueada y no deja pisarla: en un deploy las env son la verdad, y
 * permitir que el panel las contradiga vuelve el arranque impredecible.
 *
 * El archivo guarda secretos en claro (token, service key) porque el proceso
 * necesita usarlos tal cual contra Discord y Supabase. Por eso vive fuera del
 * repo (data/ está en .gitignore) y se escribe con modo 600.
 *
 * Cuenta: usuario + contraseña con scrypt. Las API keys se guardan hasheadas
 * (sha256) y el token completo se muestra una sola vez al crearlas.
 */

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const FIELDS = ['discordToken', 'supabaseUrl', 'supabaseKey', 'alertWebhook', 'selfPresence'];

const ENV_NAMES = {
  discordToken: 'DISCORD_TOKEN',
  supabaseUrl: 'SUPABASE_URL',
  supabaseKey: 'SUPABASE_SERVICE_KEY',
  alertWebhook: 'ALERT_WEBHOOK',
  selfPresence: 'SELF_PRESENCE',
};

const PRESENCE_VALUES = new Set(['online', 'idle', 'dnd', 'invisible']);
const MIN_PASSWORD = 8;
const MAX_KEYS = 25;
const KEY_PREFIX = 'xyb_';

let stored = {};
let account = null; // { username, salt, hash }
let apiKeys = []; // [{ id, name, prefix, hash, created_at, last_used_at }]
let loaded = false;
let persistTimer = null;

/* ------------------------------------------------------------------ archivo */

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

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
        // Migración v1: el panel tenía solo contraseña. La cuenta pasa a
        // llamarse `admin` y el usuario puede cambiarla desde Ajustes.
        account = {
          username: 'admin',
          salt: String(parsed.password.salt || ''),
          hash: String(parsed.password.hash || ''),
        };
      }

      apiKeys = Array.isArray(parsed.apiKeys)
        ? parsed.apiKeys
            .filter((key) => key && key.hash && key.id)
            .map((key) => ({
              id: String(key.id),
              name: String(key.name || 'API key').slice(0, 60),
              prefix: String(key.prefix || ''),
              hash: String(key.hash),
              created_at: key.created_at || new Date().toISOString(),
              last_used_at: key.last_used_at || null,
            }))
        : [];
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[settings] no se pudo leer data/settings.json:', error.message);
    }
    stored = {};
    account = null;
    apiKeys = [];
  }

  // Una clave de sesión persistida evita que cada reinicio cierre todas las
  // sesiones del panel. Si no hay, se genera y se guarda en el primer uso.
  if (typeof stored.sessionSecret === 'string' && stored.sessionSecret.length >= 32) {
    sessionSecretCache = stored.sessionSecret;
  }
}

function persist() {
  try {
    ensureDir();
    const payload = JSON.stringify(
      {
        version: 2,
        updated_at: new Date().toISOString(),
        values: stored,
        account,
        apiKeys,
      },
      null,
      2
    );
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch (error) {
    console.error('[settings] no se pudo guardar data/settings.json:', error.message);
    throw Object.assign(new Error('No se pudo guardar la configuración en disco'), { code: 'io' });
  }
}

/** Las keys marcan last_used en memoria y el archivo se escribe con delay. */
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      persist();
    } catch {
      // el próximo cambio vuelve a intentar
    }
  }, 5000);
  persistTimer.unref?.();
}

/* -------------------------------------------------------------- validación */

function envValue(field) {
  return String(process.env[ENV_NAMES[field]] || '').trim();
}

function fromEnv(field) {
  return envValue(field) !== '';
}

/** Acepta la URL del proyecto con o sin /rest/v1 y sin barra final. */
function normalizeUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid' });
}

function sanitize(field, value) {
  const raw = String(value ?? '').trim();

  if (field === 'supabaseUrl') {
    if (!raw) return '';
    const url = normalizeUrl(raw);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw invalid('La URL de Supabase no es válida');
    }
    if (parsed.protocol !== 'https:') throw invalid('La URL de Supabase tiene que ser https');
    if (!parsed.hostname.endsWith('.supabase.co') && !parsed.hostname.endsWith('.supabase.in')) {
      // Self-hosted también existe: solo avisamos si claramente no es Supabase.
      if (!/supabase/i.test(parsed.hostname)) {
        throw invalid('Esa URL no parece de Supabase');
      }
    }
    return url;
  }

  if (field === 'supabaseKey') {
    if (!raw) return '';
    if (raw.startsWith('sb_publishable_') || raw.startsWith('sb_anon')) {
      throw invalid('Esa es la clave pública. El server necesita la secret key (service_role).');
    }
    if (raw.length < 20) throw invalid('La secret key de Supabase es demasiado corta');
    if (raw.startsWith('eyJ')) {
      try {
        const payload = JSON.parse(Buffer.from(raw.split('.')[1] || '', 'base64url').toString('utf8'));
        if (payload.role && payload.role !== 'service_role') {
          throw invalid(`Esa key tiene rol "${payload.role}". Necesitás la service_role.`);
        }
      } catch (error) {
        if (error.code === 'invalid') throw error;
        // JWT raro: dejamos pasar, la prueba contra Supabase decide.
      }
    }
    return raw;
  }

  if (field === 'discordToken') {
    if (!raw) return '';
    if (/\s/.test(raw)) throw invalid('El token de Discord no puede tener espacios ni saltos de línea');
    if (raw.length < 30) throw invalid('El token de Discord es demasiado corto');
    return raw;
  }

  if (field === 'alertWebhook') {
    if (!raw) return '';
    if (!/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//i.test(raw)) {
      throw invalid('El webhook tiene que ser una URL de webhook de Discord');
    }
    return raw;
  }

  if (field === 'selfPresence') {
    if (!raw) return '';
    const value = raw.toLowerCase();
    if (!PRESENCE_VALUES.has(value)) throw invalid('SELF_PRESENCE debe ser online, idle, dnd o invisible');
    return value;
  }

  throw invalid(`Campo desconocido: ${field}`);
}

function normalizeUsername(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(raw)) {
    throw invalid('El usuario necesita 3 a 32 caracteres: letras, números, punto, guion o guion bajo');
  }
  return raw;
}

/* --------------------------------------------------------------- lectura -- */

function get() {
  load();
  const out = {};
  for (const field of FIELDS) {
    const env = envValue(field);
    out[field] = env || String(stored[field] ?? '').trim();
  }
  out.supabaseUrl = normalizeUrl(out.supabaseUrl);
  return out;
}

function hint(value, visible = 4) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= visible * 2 + 1) return '•'.repeat(raw.length);
  return `${raw.slice(0, visible)}…${raw.slice(-visible)}`;
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

/**
 * Vista para el panel: nunca devuelve el secreto completo, solo un preview y un
 * booleano. `env` marca los campos que vienen de variables de entorno y que el
 * panel no puede editar.
 */
function publicView() {
  const values = get();
  const env = {};
  for (const field of FIELDS) env[field] = fromEnv(field);
  const view = accountView();

  return {
    supabaseUrl: values.supabaseUrl,
    supabaseKeyHint: hint(values.supabaseKey, 6),
    hasSupabaseKey: Boolean(values.supabaseKey),
    discordTokenHint: hint(values.discordToken, 4),
    hasDiscordToken: Boolean(values.discordToken),
    alertWebhook: values.alertWebhook,
    selfPresence: values.selfPresence,
    username: view.username,
    accountSource: view.source,
    hasAccount: view.source !== 'none',
    keys: apiKeys.length,
    env,
    configured: {
      supabase: Boolean(values.supabaseUrl && values.supabaseKey),
      discord: Boolean(values.discordToken),
      account: view.source !== 'none',
    },
  };
}

/* --------------------------------------------------------------- escritura */

function update(patch) {
  load();
  if (!patch || typeof patch !== 'object') throw invalid('Payload inválido');

  const next = { ...stored };
  let changed = false;

  for (const field of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    if (fromEnv(field)) {
      throw invalid(`${ENV_NAMES[field]} está definida por variable de entorno y no se puede cambiar desde el panel`);
    }
    const value = sanitize(field, patch[field]);
    if (value) next[field] = value;
    else delete next[field];
    changed = true;
  }

  if (!changed) throw invalid('No hay nada para guardar');

  stored = next;
  persist();
  return get();
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

function validatePassword(value) {
  const plain = String(value ?? '');
  if (plain.length < MIN_PASSWORD) throw invalid(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`);
  if (plain.length > 200) throw invalid('La contraseña es demasiado larga');
  return plain;
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

function createAccount(username, plain) {
  load();
  if (hasAccount()) throw invalid('La cuenta ya existe');
  const name = normalizeUsername(username);
  const password = validatePassword(plain);
  const salt = crypto.randomBytes(16).toString('hex');
  account = { username: name, salt, hash: derive(password, salt) };
  persist();
  return { username: name };
}

function changeAccount(currentPassword, patch) {
  load();
  if (envPassword()) {
    throw invalid('La cuenta viene de DASHBOARD_USERNAME / DASHBOARD_PASSWORD; cambiala en el deploy');
  }
  if (!account) throw invalid('Todavía no hay cuenta');
  if (!timingEqual(derive(currentPassword, account.salt), account.hash)) {
    throw invalid('La contraseña actual no es correcta');
  }

  const nextUsername = patch?.username !== undefined && String(patch.username).trim() !== ''
    ? normalizeUsername(patch.username)
    : account.username;
  const nextPassword = patch?.password !== undefined && String(patch.password) !== ''
    ? validatePassword(patch.password)
    : null;

  const salt = nextPassword ? crypto.randomBytes(16).toString('hex') : account.salt;
  account = {
    username: nextUsername,
    salt,
    hash: nextPassword ? derive(nextPassword, salt) : account.hash,
  };
  persist();
  return { username: account.username };
}

/* --------------------------------------------------------------- api keys */

function keyView(record) {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    created_at: record.created_at,
    last_used_at: record.last_used_at,
  };
}

function listKeys() {
  load();
  return apiKeys.map(keyView);
}

function createKey(name) {
  load();
  if (apiKeys.length >= MAX_KEYS) throw invalid(`Máximo ${MAX_KEYS} keys activas; revocá alguna`);
  const label = String(name ?? '').trim().slice(0, 60) || 'API key';
  const token = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  const record = {
    id: crypto.randomBytes(8).toString('hex'),
    name: label,
    prefix: token.slice(0, 12),
    hash: crypto.createHash('sha256').update(token).digest('hex'),
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  apiKeys = [record, ...apiKeys];
  persist();
  return { token, key: keyView(record) };
}

function revokeKey(id) {
  load();
  const before = apiKeys.length;
  apiKeys = apiKeys.filter((record) => record.id !== String(id));
  if (apiKeys.length === before) throw invalid('Esa key no existe');
  persist();
  return true;
}

function verifyKey(token) {
  load();
  const raw = String(token ?? '').trim();
  if (!raw.startsWith(KEY_PREFIX)) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  for (const record of apiKeys) {
    if (!timingEqual(hash, record.hash)) continue;
    record.last_used_at = new Date().toISOString();
    schedulePersist();
    return keyView(record);
  }
  return null;
}

/* ---------------------------------------------------------- session secret */

let sessionSecretCache = '';

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
    // Sin disco escribible seguimos con la clave en memoria: las sesiones
    // duran lo que el proceso, pero el panel funciona.
  }
  return sessionSecretCache;
}

/* ------------------------------------------------------------------ reset - */

/** Solo para tests: vuelve a leer el archivo. */
function __reload() {
  loaded = false;
  stored = {};
  account = null;
  apiKeys = [];
  sessionSecretCache = '';
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  load();
}

module.exports = {
  get,
  update,
  publicView,
  accountView,
  hasAccount,
  verifyAccount,
  createAccount,
  changeAccount,
  listKeys,
  createKey,
  revokeKey,
  verifyKey,
  sessionSecret,
  normalizeUrl,
  sanitize,
  DATA_DIR,
  FILE,
  MIN_PASSWORD,
  KEY_PREFIX,
  __reload,
};
