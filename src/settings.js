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

let stored = {};
let password = null; // { salt, hash }
let loaded = false;

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
      password = parsed.password && parsed.password.hash ? parsed.password : null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[settings] no se pudo leer data/settings.json:', error.message);
    }
    stored = {};
    password = null;
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
      { version: 1, updated_at: new Date().toISOString(), values: stored, password },
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

/**
 * Vista para el panel: nunca devuelve el secreto completo, solo un preview y un
 * booleano. `env` marca los campos que vienen de variables de entorno y que el
 * panel no puede editar.
 */
function publicView() {
  const values = get();
  const env = {};
  for (const field of FIELDS) env[field] = fromEnv(field);
  const envPassword = String(process.env.DASHBOARD_PASSWORD || '').trim() !== '';

  return {
    supabaseUrl: values.supabaseUrl,
    supabaseKeyHint: hint(values.supabaseKey, 6),
    hasSupabaseKey: Boolean(values.supabaseKey),
    discordTokenHint: hint(values.discordToken, 4),
    hasDiscordToken: Boolean(values.discordToken),
    alertWebhook: values.alertWebhook,
    selfPresence: values.selfPresence,
    hasPassword: envPassword || Boolean(password),
    passwordSource: envPassword ? 'env' : password ? 'file' : 'none',
    env,
    configured: {
      supabase: Boolean(values.supabaseUrl && values.supabaseKey),
      discord: Boolean(values.discordToken),
      password: hasPassword(),
    },
  };
}

function hasPassword() {
  load();
  if (String(process.env.DASHBOARD_PASSWORD || '').trim()) return true;
  return Boolean(password);
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

/* --------------------------------------------------------------- password */

function timingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function derive(plain, salt) {
  return crypto.scryptSync(String(plain), salt, 64).toString('hex');
}

function verifyPassword(input) {
  load();
  const plain = String(input ?? '');
  const envPassword = String(process.env.DASHBOARD_PASSWORD || '').trim();
  if (envPassword) return timingEqual(plain, envPassword);
  if (!password) return false;
  return timingEqual(derive(plain, password.salt), password.hash);
}

function setPassword(plain) {
  load();
  if (String(process.env.DASHBOARD_PASSWORD || '').trim()) {
    throw invalid('DASHBOARD_PASSWORD está definida por variable de entorno; cambiala ahí');
  }
  const value = String(plain ?? '');
  if (value.length < MIN_PASSWORD) throw invalid(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`);
  if (value.length > 200) throw invalid('La contraseña es demasiado larga');
  const salt = crypto.randomBytes(16).toString('hex');
  password = { salt, hash: derive(value, salt) };
  persist();
}

function changePassword(current, next) {
  if (!verifyPassword(current)) {
    throw Object.assign(new Error('La contraseña actual no es correcta'), { code: 'invalid' });
  }
  setPassword(next);
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
  password = null;
  sessionSecretCache = '';
  load();
}

module.exports = {
  get,
  update,
  publicView,
  hasPassword,
  verifyPassword,
  setPassword,
  changePassword,
  sessionSecret,
  normalizeUrl,
  sanitize,
  DATA_DIR,
  FILE,
  MIN_PASSWORD,
  __reload,
};
