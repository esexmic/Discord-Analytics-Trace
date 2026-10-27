'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const settings = require('./settings');

/**
 * Cuentas del panel.
 *
 * - Con Supabase configurado viven en la tabla `accounts` (schema.sql v3).
 * - Sin Supabase se guardan en data/accounts.json para el modo local y tests.
 *
 * Cada cuenta tiene su propio token de Discord (`discord_token`) y su
 * identidad vinculada. El token nunca se devuelve completo: la vista pública
 * expone quién está conectado y un preview enmascarado.
 *
 * HWID: el hash del dispositivo que creó la cuenta. Un login desde otro
 * dispositivo se rechaza hasta desvincularlo desde Ajustes o recuperarlo con
 * usuario + contraseña.
 *
 * El rol admin gestiona cuentas (listar, bloquear, cambiar contraseña, borrar)
 * sobre las columnas de uso: ip, user_agent, contadores y `status`.
 */

const TABLE = 'accounts';
const FILE = path.join(settings.DATA_DIR, 'accounts.json');
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const RECORD_CACHE_MS = 20_000;
const SESSION_CACHE_MS = 60_000;

let fileCache = null;
let recordCache = new Map(); // username -> { at, record }
let sessionCache = new Map(); // username -> { at, version, view }
let anyCache = { at: 0, value: false };

function authError(message, code = 'invalid') {
  return Object.assign(new Error(message), { code });
}

function normalizeUsername(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(raw)) {
    throw authError('El usuario necesita 3 a 32 caracteres: letras, números, punto, guion o guion bajo');
  }
  return raw;
}

function validatePassword(value) {
  const plain = String(value ?? '');
  if (plain.length < MIN_PASSWORD) throw authError(`La contraseña necesita al menos ${MIN_PASSWORD} caracteres`);
  if (plain.length > MAX_PASSWORD) throw authError('La contraseña es demasiado larga');
  return plain;
}

function validateHwid(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(raw)) {
    throw authError('No se pudo identificar el dispositivo; recargá el panel y probá de nuevo');
  }
  return raw;
}

function hashHwid(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function derive(plain, salt) {
  return crypto.scryptSync(String(plain), salt, 64).toString('hex');
}

function timingEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function discordView(record) {
  if (!record?.discord_token) return { linked: false, user_id: null, username: null, avatar: null };
  return {
    linked: true,
    user_id: record.discord_user_id || null,
    username: record.discord_username || null,
    avatar: record.discord_avatar || null,
    // Preview para el admin: alcanza para reconocer el token sin exponerlo.
    token_preview: maskToken(record.discord_token),
  };
}

function maskToken(token) {
  const value = String(token || '');
  if (value.length <= 12) return `${value.slice(0, 3)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/* ----------------------------------------------------------------- webhook -- */

const WEBHOOK_MAX = 2048;
// Un webhook de Discord es https y su token va dentro de la URL: la URL completa
// es un secreto. Se valida contra este patrón para no guardar cualquier cosa.
const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d{15,25})\/([\w-]{1,120})$/;

function validateWebhook(value) {
  const raw = String(value ?? '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
  if (!raw) throw authError('Pegá la URL del webhook de Discord', 'invalid');
  if (raw.length > WEBHOOK_MAX) throw authError('La URL del webhook es demasiado larga', 'invalid');
  if (!WEBHOOK_RE.test(raw)) {
    throw authError('Esa no es una URL de webhook de Discord (https://discord.com/api/webhooks/…)', 'invalid');
  }
  return raw;
}

/** Vista para el panel: el id del webhook y cuatro caracteres del token. */
function maskWebhook(url) {
  const match = WEBHOOK_RE.exec(String(url || ''));
  if (!match) return null;
  const token = match[2];
  return `https://discord.com/api/webhooks/${match[1]}/${token.slice(0, 4)}…`;
}

function webhookView(record) {
  const preview = maskWebhook(record?.webhook_url);
  return { configured: Boolean(preview), preview };
}

function publicView(record) {
  if (!record) return null;
  return {
    username: record.username,
    role: record.role || 'user',
    status: record.status || 'active',
    block_reason: record.block_reason || null,
    hwid_linked: Boolean(record.hwid_hash),
    hwid_label: record.hwid_label || null,
    session_version: Number(record.session_version) || 0,
    created_at: record.created_at || null,
    last_login_at: record.last_login_at || null,
    last_seen_at: record.last_seen_at || null,
    last_ip: record.last_ip || null,
    user_agent: record.user_agent || null,
    login_count: Number(record.login_count) || 0,
    boot_count: Number(record.boot_count) || 0,
    hasToken: Boolean(record.discord_token),
    discord: discordView(record),
    webhook: webhookView(record),
  };
}

function isBlocked(record) {
  return String(record?.status || 'active') === 'blocked';
}

function blockedError(record) {
  const reason = record?.block_reason ? ` Motivo: ${record.block_reason}` : '';
  return authError(`Esta cuenta está bloqueada.${reason} Pedile al admin que la reactive.`, 'blocked');
}

/* ---------------------------------------------------------------- storage -- */

function readFile() {
  if (fileCache) return fileCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    fileCache = Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[accounts] no se pudo leer data/accounts.json:', error.message);
    }
    fileCache = [];
  }
  return fileCache;
}

function writeFile(records) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const payload = JSON.stringify({ version: 2, accounts: records }, null, 2);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  fileCache = records;
}

function invalidateCache(username) {
  anyCache = { at: 0, value: false };
  if (username) {
    recordCache.delete(username);
    sessionCache.delete(username);
  } else {
    recordCache = new Map();
    sessionCache = new Map();
  }
}

function dbError(error) {
  const message = error?.message || 'error desconocido';
  const code = String(error?.code || '');
  db.noteFailure(error);

  if (code === 'PGRST204' || /column .* does not exist/i.test(message)) {
    return authError('Falta correr schema.sql: la tabla accounts no tiene las columnas nuevas', 'schema');
  }
  if (/does not exist|relation|42P01/i.test(message)) {
    return authError('Falta correr schema.sql: la tabla accounts no existe', 'schema');
  }
  if (/invalid api key|jwt|401|403|permission/i.test(message)) {
    return authError('La base rechazó las credenciales del servidor; revisá la service key del deploy', 'db_unavailable');
  }
  return authError(`Base de cuentas no disponible: ${message}`, 'db_unavailable');
}

async function findRecord(username) {
  const cached = recordCache.get(username);
  if (cached && Date.now() - cached.at < RECORD_CACHE_MS) return cached.record;

  let record = null;
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient().from(TABLE).select('*').eq('username', username).limit(1);
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) throw dbError(response.error);
    record = response.data?.[0] ?? null;
  } else {
    record = readFile().find((row) => row.username === username) ?? null;
  }

  recordCache.set(username, { at: Date.now(), record });
  return record;
}

async function hasAny() {
  if (anyCache.at && Date.now() - anyCache.at < RECORD_CACHE_MS) return anyCache.value;

  // La cuenta legacy del deploy ya ocupa el lugar del admin.
  if (settings.accountView().source !== 'none') {
    anyCache = { at: Date.now(), value: true };
    return true;
  }

  let value = false;
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient().from(TABLE).select('username').limit(1);
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) throw dbError(response.error);
    value = (response.data || []).length > 0;
  } else {
    value = readFile().length > 0;
  }

  anyCache = { at: Date.now(), value };
  return value;
}

async function insertRecord(record) {
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient().from(TABLE).insert(record).select();
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) {
      if (response.error.code === '23505') throw authError('Ese usuario ya existe', 'exists');
      throw dbError(response.error);
    }
    invalidateCache(record.username);
    return response.data?.[0] ?? record;
  }

  const records = [...readFile()];
  if (records.some((row) => row.username === record.username)) {
    throw authError('Ese usuario ya existe', 'exists');
  }
  records.push(record);
  writeFile(records);
  invalidateCache(record.username);
  return record;
}

async function updateRecord(username, patch) {
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient().from(TABLE).update(patch).eq('username', username).select();
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) {
      if (response.error.code === '23505') throw authError('Ese usuario ya existe', 'exists');
      throw dbError(response.error);
    }
    invalidateCache(username);
    if (patch.username && patch.username !== username) invalidateCache(patch.username);
    return response.data?.[0] ?? null;
  }

  const records = readFile();
  const index = records.findIndex((row) => row.username === username);
  if (index < 0) return null;
  if (patch.username && patch.username !== username
    && records.some((row) => row.username === patch.username)) {
    throw authError('Ese usuario ya existe', 'exists');
  }
  records[index] = { ...records[index], ...patch };
  writeFile(records);
  invalidateCache(username);
  if (patch.username) invalidateCache(patch.username);
  return records[index];
}

function newRecord({ username, password, hwid, hwidLabel, role, ip, userAgent }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString();
  return {
    username,
    role,
    password_salt: salt,
    password_hash: derive(password, salt),
    hwid_hash: hwid ? hashHwid(hwid) : null,
    hwid_label: hwidLabel || null,
    session_version: 0,
    status: 'active',
    block_reason: null,
    created_at: now,
    last_login_at: now,
    last_seen_at: now,
    last_ip: ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 240) : null,
    login_count: 1,
    boot_count: 0,
  };
}

/** Patch de login: contadores y última huella visible para el admin. */
function loginPatch(record, { ip, userAgent } = {}) {
  return {
    last_login_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    last_ip: ip || record?.last_ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 240) : record?.user_agent || null,
    login_count: (Number(record?.login_count) || 0) + 1,
  };
}

/** Migra la cuenta legacy (env o settings.json) a la base al primer login. */
async function provisionLegacy(username, password, { hwid, hwidLabel, ip, userAgent } = {}) {
  const record = newRecord({
    username,
    password,
    hwid,
    hwidLabel,
    role: 'admin',
    ip,
    userAgent,
  });
  try {
    return await insertRecord(record);
  } catch (error) {
    if (error.code === 'exists') return findRecord(username);
    throw error;
  }
}

function hwidLabelName(value) {
  const label = String(value?.hwidLabel ?? '').trim();
  return label ? label.slice(0, 120) : null;
}

/* ---------------------------------------------------------------- público -- */

/**
 * Alta abierta: cualquiera que entre a la web puede crear su cuenta. El HWID
 * ata la cuenta al primer dispositivo; la recuperación pide usuario +
 * contraseña y revincula.
 */
async function register({ username, password, hwid, hwidLabel, ip, userAgent }) {
  const name = normalizeUsername(username);
  const plain = validatePassword(password);
  const device = validateHwid(hwid);
  const label = hwidLabelName({ hwidLabel });

  if (await findRecord(name)) throw authError('Ese usuario ya existe', 'exists');

  const first = !(await hasAny());
  const created = await insertRecord(newRecord({
    username: name,
    password: plain,
    hwid: device,
    hwidLabel: label,
    role: first ? 'admin' : 'user',
    ip,
    userAgent,
  }));

  return publicView(created);
}

async function authenticate({ username, password, hwid, hwidLabel, ip, userAgent } = {}) {
  let name;
  try {
    name = normalizeUsername(username);
  } catch {
    throw authError('Usuario o contraseña incorrectos');
  }

  const plain = String(password ?? '');
  const label = hwidLabelName({ hwidLabel });
  let record = null;
  try {
    record = await findRecord(name);
  } catch (error) {
    if (error.code !== 'db_unavailable') throw error;
    console.warn('[accounts]', error.message);
  }
  if (isBlocked(record)) throw blockedError(record);

  const legacyOk = settings.verifyAccount(name, plain);

  // La cuenta del deploy manda: si cambia la contraseña en el entorno tiene
  // que poder entrar aunque en la base quede el hash viejo.
  if (legacyOk) {
    if (record) {
      const patch = loginPatch(record, { ip, userAgent });
      await updateRecord(name, patch);
      return publicView({ ...record, ...patch });
    }
    try {
      const created = await provisionLegacy(name, plain, { hwid, hwidLabel: label, ip, userAgent });
      return publicView(created);
    } catch (error) {
      if (error.code !== 'db_unavailable' && error.code !== 'schema') throw error;
      console.warn('[accounts] login legacy sin persistir:', error.message);
      return {
        username: name,
        role: 'admin',
        status: 'active',
        hwid_linked: Boolean(hwid),
        hwid_label: label,
        session_version: 0,
        login_count: 1,
        hasToken: false,
        discord: { linked: false },
      };
    }
  }

  if (record) {
    const passwordOk = timingEqual(derive(plain, record.password_salt), record.password_hash);
    if (!passwordOk) throw authError('Usuario o contraseña incorrectos', 'bad_credentials');

    const device = String(hwid ?? '').trim().toLowerCase();
    if (record.hwid_hash) {
      if (!device || !timingEqual(hashHwid(device), record.hwid_hash)) {
        throw authError('Esta cuenta está vinculada a otro dispositivo. Usá "Cambié de dispositivo" para revincularla.', 'hwid_mismatch');
      }
    } else if (device) {
      const updated = await updateRecord(name, {
        hwid_hash: hashHwid(device),
        hwid_label: label || record.hwid_label || null,
      });
      if (updated) record.hwid_hash = updated.hwid_hash;
    }

    const patch = loginPatch(record, { ip, userAgent });
    await updateRecord(name, patch);
    return publicView({ ...record, ...patch });
  }

  throw authError('Usuario o contraseña incorrectos', 'bad_credentials');
}

async function changeAccount(username, current, patch = {}) {
  const record = await findRecord(username);
  if (!record) {
    if (settings.verifyAccount(username, current)) {
      const migrated = await provisionLegacy(username, current, {});
      return changeAccount(migrated.username, current, patch);
    }
    throw authError('La cuenta no existe', 'not_found');
  }
  if (!timingEqual(derive(current, record.password_salt), record.password_hash)) {
    throw authError('La contraseña actual no es correcta', 'bad_credentials');
  }

  const nextUsername = patch.username !== undefined && String(patch.username).trim() !== ''
    ? normalizeUsername(patch.username)
    : record.username;
  const nextPassword = patch.password !== undefined && String(patch.password) !== ''
    ? validatePassword(patch.password)
    : null;

  const next = { username: nextUsername };
  if (nextPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    next.password_salt = salt;
    next.password_hash = derive(nextPassword, salt);
    next.session_version = (Number(record.session_version) || 0) + 1;
  }

  const updated = await updateRecord(record.username, next);
  return publicView(updated || { ...record, ...next });
}

/**
 * Revincula la cuenta a este dispositivo con usuario + contraseña. No pide
 * key: la contraseña es la prueba de identidad.
 */
async function rebindDevice({ username, password, hwid, hwidLabel, ip, userAgent } = {}) {
  const name = normalizeUsername(username);
  const plain = String(password ?? '');
  const device = validateHwid(hwid);
  const label = hwidLabelName({ hwidLabel });

  const record = await findRecord(name);
  if (!record) throw authError('Usuario o contraseña incorrectos', 'bad_credentials');
  if (isBlocked(record)) throw blockedError(record);
  if (!timingEqual(derive(plain, record.password_salt), record.password_hash)) {
    throw authError('Usuario o contraseña incorrectos', 'bad_credentials');
  }

  const updated = await updateRecord(name, {
    hwid_hash: hashHwid(device),
    hwid_label: label,
    session_version: (Number(record.session_version) || 0) + 1,
    ...loginPatch(record, { ip, userAgent }),
  });
  return publicView(updated || record);
}

async function resetHwid(username, password) {
  const record = await findRecord(username);
  if (!record) throw authError('La cuenta no existe', 'not_found');
  if (!timingEqual(derive(password, record.password_salt), record.password_hash)) {
    throw authError('La contraseña no es correcta', 'bad_credentials');
  }
  const updated = await updateRecord(username, {
    hwid_hash: null,
    hwid_label: null,
    session_version: (Number(record.session_version) || 0) + 1,
  });
  return publicView(updated);
}

/* ------------------------------------------------------------ uso real --- */

const USAGE_WRITE_MS = 30_000;
const usageThrottle = new Map(); // username -> at

/**
 * Marca que la cuenta usó la página. Lo llama /api/bootstrap, que es lo único
 * que se pide en cada carga completa; por eso se corta con un throttle de 30s
 * para no escribir en la base en cada foco/refresh.
 */
async function touchUsage(username, { ip, userAgent } = {}) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return null;

  const now = Date.now();
  if (now - (usageThrottle.get(name) || 0) < USAGE_WRITE_MS) return null;
  usageThrottle.set(name, now);
  if (usageThrottle.size > 5000) usageThrottle.clear();

  const record = await findRecord(name);
  if (!record) return null;

  const patch = {
    boot_count: (Number(record.boot_count) || 0) + 1,
    last_seen_at: new Date().toISOString(),
    last_ip: ip || record.last_ip || null,
    user_agent: userAgent ? String(userAgent).slice(0, 240) : record.user_agent || null,
  };
  await updateRecord(name, patch);
  return patch;
}

/* ------------------------------------------------------------------ admin -- */

const ADMIN_STATUSES = new Set(['active', 'blocked']);
const ADMIN_ROLES = new Set(['admin', 'user']);

/** Filas crudas: el server decide qué campo de cada cuenta sale al panel. */
async function listAdmin() {
  if (db.isConfigured()) {
    let response;
    try {
      response = await db
        .getClient()
        .from(TABLE)
        .select('*')
        .order('created_at', { ascending: true });
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) throw dbError(response.error);
    return response.data || [];
  }
  return readFile();
}

/** Bloquear es reversible y cierra las sesiones de esa cuenta de inmediato. */
async function setStatus(username, status, reason) {
  const name = normalizeUsername(username);
  if (!ADMIN_STATUSES.has(status)) throw authError('Estado inválido', 'invalid');

  const record = await findRecord(name);
  if (!record) throw authError('La cuenta no existe', 'not_found');

  const patch = {
    status,
    block_reason: status === 'blocked' ? String(reason || '').trim().slice(0, 200) || null : null,
    session_version: (Number(record.session_version) || 0) + 1,
  };
  const updated = await updateRecord(name, patch);
  return publicView(updated || { ...record, ...patch });
}

async function setRole(username, role) {
  const name = normalizeUsername(username);
  if (!ADMIN_ROLES.has(role)) throw authError('Rol inválido', 'invalid');

  const record = await findRecord(name);
  if (!record) throw authError('La cuenta no existe', 'not_found');

  const updated = await updateRecord(name, { role });
  return publicView(updated || { ...record, role });
}

/** El admin fija una contraseña nueva: la vieja es un hash, no se puede leer. */
async function adminSetPassword(username, password) {
  const name = normalizeUsername(username);
  const plain = validatePassword(password);
  const record = await findRecord(name);
  if (!record) throw authError('La cuenta no existe', 'not_found');

  const salt = crypto.randomBytes(16).toString('hex');
  const patch = {
    password_salt: salt,
    password_hash: derive(plain, salt),
    session_version: (Number(record.session_version) || 0) + 1,
  };
  const updated = await updateRecord(name, patch);
  return publicView(updated || { ...record, ...patch });
}

async function adminUnlinkHwid(username) {
  const name = normalizeUsername(username);
  const record = await findRecord(name);
  if (!record) throw authError('La cuenta no existe', 'not_found');

  const patch = {
    hwid_hash: null,
    hwid_label: null,
    session_version: (Number(record.session_version) || 0) + 1,
  };
  const updated = await updateRecord(name, patch);
  return publicView(updated || { ...record, ...patch });
}

async function removeAccount(username) {
  const name = normalizeUsername(username);
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient().from(TABLE).delete().eq('username', name);
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) throw dbError(response.error);
    if (!(response.data || []).length) throw authError('La cuenta no existe', 'not_found');
  } else {
    const records = readFile();
    const kept = records.filter((row) => row.username !== name);
    if (kept.length === records.length) throw authError('La cuenta no existe', 'not_found');
    writeFile(kept);
  }
  invalidateCache(name);
  usageThrottle.delete(name);
  return { username: name };
}

/* ------------------------------------------------------- token de Discord -- */

async function saveDiscord(username, { token, userId, username: discordUsername, avatar }) {
  const updated = await updateRecord(username, {
    discord_token: token,
    discord_user_id: userId || null,
    discord_username: discordUsername || null,
    discord_avatar: avatar || null,
  });
  if (!updated) throw authError('La cuenta no existe', 'not_found');
  return updated;
}

/** Actualiza solo la identidad visible cuando el gateway termina de conectar. */
async function saveDiscordIdentity(username, { userId, username: discordUsername, avatar }) {
  const record = await findRecord(username);
  if (!record?.discord_token) return null;
  if (record.discord_user_id === userId
    && record.discord_username === discordUsername
    && record.discord_avatar === avatar) {
    return record;
  }
  return updateRecord(username, {
    discord_user_id: userId || null,
    discord_username: discordUsername || null,
    discord_avatar: avatar || null,
  });
}

async function clearDiscord(username) {
  const updated = await updateRecord(username, {
    discord_token: null,
    discord_user_id: null,
    discord_username: null,
    discord_avatar: null,
  });
  return updated;
}

/** Cuentas con token guardado, para reconectar los bots al arrancar. */
async function listWithTokens() {
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient()
        .from(TABLE)
        .select('username, discord_token')
        .not('discord_token', 'is', null);
    } catch (error) {
      console.warn('[accounts] no se pudo listar los tokens:', error.message);
      return [];
    }
    if (response.error) {
      console.warn('[accounts] no se pudo listar los tokens:', response.error.message);
      return [];
    }
    return (response.data || []).filter((row) => row.discord_token);
  }

  return readFile().filter((row) => row.discord_token).map((row) => ({
    username: row.username,
    discord_token: row.discord_token,
  }));
}

/** Registro completo, uso interno (bot). Nunca se manda al cliente. */
async function getRecord(username) {
  return findRecord(String(username ?? '').trim().toLowerCase());
}

/* ---------------------------------------------------------------- webhook --- */

/**
 * La cuenta del deploy puede entrar con las variables del entorno sin fila en
 * `accounts`. Guardarle algo (el webhook) necesita la fila: se crea con una
 * contraseña aleatoria, porque el acceso de esa cuenta sigue siendo el de las
 * variables y el login legacy tiene prioridad sobre el hash.
 */
async function ensureRecord(username) {
  const existing = await findRecord(username);
  if (existing) return existing;

  const legacy = settings.accountView();
  if (legacy.source !== 'env' || legacy.username !== username) return null;

  try {
    return await insertRecord(newRecord({
      username,
      password: crypto.randomBytes(24).toString('base64url'),
      role: 'admin',
    }));
  } catch (error) {
    if (error.code !== 'exists') throw error;
    return findRecord(username);
  }
}

/** Guarda la URL del webhook de la cuenta; reemplaza la anterior. */
async function saveWebhook(username, url) {
  const name = String(username ?? '').trim().toLowerCase();
  const record = await ensureRecord(name);
  if (!record) throw authError('La cuenta no existe', 'not_found');

  const next = validateWebhook(url);
  const updated = await updateRecord(name, { webhook_url: next });
  return webhookView(updated || { ...record, webhook_url: next });
}

async function clearWebhook(username) {
  const name = String(username ?? '').trim().toLowerCase();
  const record = await ensureRecord(name);
  if (!record) throw authError('La cuenta no existe', 'not_found');

  const updated = await updateRecord(name, { webhook_url: null });
  return webhookView(updated || { ...record, webhook_url: null });
}

/** URL cruda de la cuenta, para el despacho interno. */
async function webhookUrl(username) {
  const record = await getRecord(username);
  return record?.webhook_url || null;
}

/** Valida que la cuenta siga existiendo y que la sesión no fue revocada. */
async function validateSession(username, version) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return null;
  const wanted = Number(version) || 0;

  const cached = sessionCache.get(name);
  if (cached && cached.version === wanted && Date.now() - cached.at < SESSION_CACHE_MS) {
    return cached.view;
  }

  let record = null;
  try {
    record = await findRecord(name);
  } catch (error) {
    if (error.code !== 'db_unavailable' && error.code !== 'schema') throw error;
    if (cached && cached.version === wanted) return cached.view;
    record = null;
  }

  if (!record) {
    const legacy = settings.accountView();
    if (legacy.source !== 'none' && legacy.username === name) {
      return { username: name, role: 'admin', session_version: 0, legacy: true, hasToken: false, discord: { linked: false } };
    }
    return null;
  }

  if ((Number(record.session_version) || 0) !== wanted) return null;
  if (isBlocked(record)) return null;

  const view = publicView(record);
  sessionCache.set(name, { at: Date.now(), version: wanted, view });
  return view;
}

module.exports = {
  register,
  authenticate,
  changeAccount,
  rebindDevice,
  resetHwid,
  validateSession,
  getRecord,
  saveDiscord,
  saveDiscordIdentity,
  clearDiscord,
  saveWebhook,
  clearWebhook,
  webhookUrl,
  maskWebhook,
  validateWebhook,
  listWithTokens,
  touchUsage,
  listAdmin,
  setStatus,
  setRole,
  adminSetPassword,
  adminUnlinkHwid,
  removeAccount,
  hasAny,
  publicView,
  normalizeUsername,
  MIN_PASSWORD,
  FILE,
  __reset: () => {
    fileCache = null;
    recordCache = new Map();
    sessionCache = new Map();
    usageThrottle.clear();
    anyCache = { at: 0, value: false };
  },
};
