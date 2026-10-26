'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const settings = require('./settings');

/**
 * Cuentas del panel.
 *
 * - Con Supabase configurado viven en la tabla `accounts` (schema.sql).
 * - Sin Supabase se guardan en data/accounts.json para que el modo local y los
 *   tests sigan funcionando sin credenciales.
 *
 * Cada cuenta tiene un `hwid_hash`: el hash del identificador del navegador que
 * la creó. Un login desde otro dispositivo se rechaza hasta que se desvincule
 * desde Ajustes (contraseña) o se use la cuenta legacy del deploy.
 *
 * Las contraseñas usan scrypt con salt por cuenta. La cuenta legacy (env o
 * data/settings.json) se migra sola a la base la primera vez que se loguea.
 */

const TABLE = 'accounts';
const FILE = path.join(settings.DATA_DIR, 'accounts.json');
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const CACHE_MS = 15_000;

let fileCache = null;
let recordCache = new Map(); // username -> { at, record }
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
  const payload = JSON.stringify({ version: 1, accounts: records }, null, 2);
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  fileCache = records;
}

function invalidateCache(username) {
  anyCache = { at: 0, value: false };
  if (username) recordCache.delete(username);
  else recordCache = new Map();
}

function dbError(error) {
  const message = error?.message || 'error desconocido';
  if (/does not exist|relation|42P01/i.test(message)) {
    return authError('Falta la tabla accounts: corré schema.sql en Supabase', 'db_unavailable');
  }
  return authError(`Base de cuentas no disponible: ${message}`, 'db_unavailable');
}

async function findRecord(username) {
  const cached = recordCache.get(username);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.record;

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
  if (anyCache.at && Date.now() - anyCache.at < CACHE_MS) return anyCache.value;

  // La cuenta legacy (deploy o settings.json) ya ocupa el lugar del admin: una
  // cuenta nueva nunca puede nacer como admin aunque la tabla esté vacía.
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

/* ---------------------------------------------------------------- público -- */

async function register({ username, password, key, hwid, hwidLabel, ip }) {
  if (!settings.verifyRegistrationKey(key)) {
    throw authError('La key de acceso no es válida', 'bad_key');
  }

  const name = normalizeUsername(username);
  const plain = validatePassword(password);
  const device = validateHwid(hwid);

  if (await findRecord(name)) throw authError('Ese usuario ya existe', 'exists');

  const first = !(await hasAny());
  const created = await insertRecord(newRecord({
    username: name,
    password: plain,
    hwid: device,
    hwidLabel,
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
  const record = await findRecord(name);
  const legacyOk = settings.verifyAccount(name, plain);

  // La cuenta del deploy (env o data/settings.json) manda: si cambia la
  // contraseña en Railway tiene que poder entrar aunque en la base quede el
  // hash viejo. No se le exige HWID para no dejar al admin afuera.
  if (legacyOk) {
    if (record) {
      await updateRecord(name, { last_login_at: new Date().toISOString(), last_ip: ip || null });
      return publicView(record);
    }
    const created = await provisionLegacy(name, plain, { hwid, hwidLabel: label, ip });
    return publicView(created);
  }

  if (record) {
    const passwordOk = timingEqual(derive(plain, record.password_salt), record.password_hash);
    if (!passwordOk) throw authError('Usuario o contraseña incorrectos', 'bad_credentials');

    const device = String(hwid ?? '').trim().toLowerCase();
    if (record.hwid_hash) {
      if (!device || !timingEqual(hashHwid(device), record.hwid_hash)) {
        throw authError('Esta cuenta está vinculada a otro dispositivo. Desvinculala desde Ajustes → Cuenta.', 'hwid_mismatch');
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

function hwidLabelName(value) {
  const label = String(value?.hwidLabel ?? '').trim();
  return label ? label.slice(0, 120) : null;
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
 * Recupera una cuenta que quedó atada a un dispositivo que ya no existe
 * (formateo, borrado de datos del navegador). Exige la key de registro además
 * de la contraseña para que no sea un bypass del HWID.
 */
async function rebindDevice({ username, password, key, hwid, hwidLabel, ip } = {}) {
  if (!settings.verifyRegistrationKey(key)) {
    throw authError('La key de acceso no es válida', 'bad_key');
  }
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

/** Valida que la cuenta siga existiendo y que la sesión no fue revocada. */
async function validateSession(username, version) {
  const name = String(username ?? '').trim().toLowerCase();
  if (!name) return null;
  const record = await findRecord(name);
  if (!record) {
    const legacy = settings.accountView();
    if (legacy.source !== 'none' && legacy.username === name) {
      return { username: name, role: 'admin', session_version: 0, legacy: true };
    }
    return null;
  }
  if ((Number(record.session_version) || 0) !== (Number(version) || 0)) return null;
  return {
    username: record.username,
    role: record.role || 'user',
    session_version: Number(record.session_version) || 0,
    hwid_linked: Boolean(record.hwid_hash),
    hwid_label: record.hwid_label || null,
  };
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
    return (response.data || []).map((row) => publicView({
      ...row,
      hwid_hash: row.hwid_hash,
    }));
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
  list,
  hasAny,
  publicView,
  normalizeUsername,
  MIN_PASSWORD,
  FILE,
  __reset: () => {
    fileCache = null;
    recordCache = new Map();
    anyCache = { at: 0, value: false };
  },
};
