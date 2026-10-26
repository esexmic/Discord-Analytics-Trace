'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const settings = require('./settings');

/**
 * Cuentas del panel.
 *
 * - Con Supabase configurado viven en la tabla `accounts` (schema.sql v2).
 * - Sin Supabase se guardan en data/accounts.json para el modo local y tests.
 *
 * Cada cuenta tiene su propio token de Discord (`discord_token`) y su
 * identidad vinculada. El token nunca se devuelve al cliente: la vista pública
 * solo expone si hay token y quién está conectado.
 *
 * HWID: el hash del dispositivo que creó la cuenta. Un login desde otro
 * dispositivo se rechaza hasta desvincularlo desde Ajustes o recuperarlo con
 * usuario + contraseña.
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
  };
}

function publicView(record) {
  if (!record) return null;
  return {
    username: record.username,
    role: record.role || 'user',
    hwid_linked: Boolean(record.hwid_hash),
    hwid_label: record.hwid_label || null,
    session_version: Number(record.session_version) || 0,
    created_at: record.created_at || null,
    last_login_at: record.last_login_at || null,
    hasToken: Boolean(record.discord_token),
    discord: discordView(record),
  };
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

function newRecord({ username, password, hwid, hwidLabel, role, ip }) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    username,
    role,
    password_salt: salt,
    password_hash: derive(password, salt),
    hwid_hash: hwid ? hashHwid(hwid) : null,
    hwid_label: hwidLabel || null,
    session_version: 0,
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
    last_ip: ip || null,
  };
}

/** Migra la cuenta legacy (env o settings.json) a la base al primer login. */
async function provisionLegacy(username, password, { hwid, hwidLabel, ip } = {}) {
  const record = newRecord({
    username,
    password,
    hwid,
    hwidLabel,
    role: 'admin',
    ip,
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
async function register({ username, password, hwid, hwidLabel, ip }) {
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
  }));

  return publicView(created);
}

async function authenticate({ username, password, hwid, hwidLabel, ip } = {}) {
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
  const legacyOk = settings.verifyAccount(name, plain);

  // La cuenta del deploy manda: si cambia la contraseña en el entorno tiene
  // que poder entrar aunque en la base quede el hash viejo.
  if (legacyOk) {
    if (record) {
      await updateRecord(name, { last_login_at: new Date().toISOString(), last_ip: ip || null });
      return publicView({ ...record, last_login_at: new Date().toISOString() });
    }
    try {
      const created = await provisionLegacy(name, plain, { hwid, hwidLabel: label, ip });
      return publicView(created);
    } catch (error) {
      if (error.code !== 'db_unavailable' && error.code !== 'schema') throw error;
      console.warn('[accounts] login legacy sin persistir:', error.message);
      return {
        username: name,
        role: 'admin',
        hwid_linked: Boolean(hwid),
        hwid_label: label,
        session_version: 0,
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

    await updateRecord(name, { last_login_at: new Date().toISOString(), last_ip: ip || null });
    return publicView(record);
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
async function rebindDevice({ username, password, hwid, hwidLabel, ip } = {}) {
  const name = normalizeUsername(username);
  const plain = String(password ?? '');
  const device = validateHwid(hwid);
  const label = hwidLabelName({ hwidLabel });

  const record = await findRecord(name);
  if (!record) throw authError('Usuario o contraseña incorrectos', 'bad_credentials');
  if (!timingEqual(derive(plain, record.password_salt), record.password_hash)) {
    throw authError('Usuario o contraseña incorrectos', 'bad_credentials');
  }

  const updated = await updateRecord(name, {
    hwid_hash: hashHwid(device),
    hwid_label: label,
    session_version: (Number(record.session_version) || 0) + 1,
    last_login_at: new Date().toISOString(),
    last_ip: ip || null,
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

  const view = publicView(record);
  sessionCache.set(name, { at: Date.now(), version: wanted, view });
  return view;
}

async function list() {
  if (db.isConfigured()) {
    let response;
    try {
      response = await db.getClient()
        .from(TABLE)
        .select('username, role, hwid_hash, hwid_label, created_at, last_login_at')
        .order('created_at', { ascending: true });
    } catch (error) {
      throw dbError(error);
    }
    if (response.error) throw dbError(response.error);
    return (response.data || []).map((row) => publicView(row));
  }
  return readFile().map(publicView);
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
  listWithTokens,
  list,
  hasAny,
  publicView,
  normalizeUsername,
  MIN_PASSWORD,
  FILE,
  __reset: () => {
    fileCache = null;
    recordCache = new Map();
    sessionCache = new Map();
    anyCache = { at: 0, value: false };
  },
};
