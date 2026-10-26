'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const config = require('./config');
const db = require('./db');
const net = require('./net');
const queue = require('./queue');
const targets = require('./targets');
const settings = require('./settings');
const accounts = require('./accounts');
const {
  startBot,
  stopBot,
  getClient,
  getPresenceSnapshot,
  getPresenceDetails,
  getVoiceSnapshot,
  getProfile,
  rememberProfile,
  avatarUrl,
  botStatus,
  displayName,
} = require('./bot');

const app = express();
const COOKIE_NAME = 'xyb_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_TYPES = [
  'message',
  'message_edit',
  'message_delete',
  'voice_join',
  'voice_leave',
  'voice_move',
  'voice_stream',
  'voice_camera',
  'presence',
  'profile_update',
];

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

/* ------------------------------------------------------------------ auth -- */

function sign(payload) {
  return crypto.createHmac('sha256', settings.sessionSecret()).update(payload).digest('base64url');
}

function issueToken(account) {
  const payload = Buffer.from(JSON.stringify({
    u: account.username,
    v: Number(account.session_version) || 0,
    exp: Date.now() + SESSION_MS,
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Devuelve el payload { u, v, exp } o null si la firma/vencimiento no dan. */
function readToken(token) {
  if (!token) return null;
  const index = token.lastIndexOf('.');
  if (index < 1) return null;
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expected = sign(payload);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return null;
  if (!crypto.timingSafeEqual(given, want)) return null;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.u !== 'string' || Number(parsed.exp) <= Date.now()) return null;
  return parsed;
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      const raw = rest.join('=');
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return null;
}

function cookie(req, value, maxAgeSeconds) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (req.secure) parts.push('Secure');
  return parts.join('; ');
}

/** Acepta `Authorization: Bearer xyb_…` o `x-api-key: xyb_…`. */
function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  if (/^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  const key = req.headers['x-api-key'];
  return typeof key === 'string' ? key.trim() : '';
}

async function currentAuth(req) {
  const payload = readToken(readCookie(req, COOKIE_NAME));
  if (payload) {
    const account = await accounts.validateSession(payload.u, payload.v);
    if (account) return { type: 'session', account };
  }
  const token = bearerToken(req);
  if (!token) return null;
  const key = settings.verifyKey(token);
  return key ? { type: 'key', key } : null;
}

async function requireAuth(req, res, next) {
  try {
    const auth = await currentAuth(req);
    if (!auth) {
      return res.status(401).json({ error: 'Sesión o API key requerida' });
    }
    req.auth = auth;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

/** Rutas sensibles: credenciales, keys y control del bot. Solo cookie. */
function requireSession(req, res, next) {
  if (req.auth?.type !== 'session') {
    return res.status(403).json({ error: 'Esta ruta necesita sesión del panel, no API key' });
  }
  next();
}

const attempts = new Map();
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 60_000;

function rateLimited(ip) {
  const entry = attempts.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.reset) {
    attempts.delete(ip);
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

/** Solo cuentan los intentos fallidos: loguearse bien no gasta cupo. */
function noteFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, reset: now + ATTEMPT_WINDOW_MS };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + ATTEMPT_WINDOW_MS;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  if (attempts.size > 5000) attempts.clear();
}

app.post('/api/login', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto' });
  }

  try {
    const account = await accounts.authenticate({
      username: req.body?.username,
      password: req.body?.password,
      hwid: req.body?.hwid,
      hwidLabel: req.body?.hwid_label,
      ip,
    });
    res.setHeader('Set-Cookie', cookie(req, issueToken(account), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true, username: account.username, role: account.role, account });
  } catch (error) {
    noteFailure(ip);
    sendError(res, error);
  }
});

async function handleRegister(req, res) {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto' });
  }

  try {
    const account = await accounts.register({
      username: req.body?.username,
      password: req.body?.password,
      key: req.body?.key ?? req.body?.access_key,
      hwid: req.body?.hwid,
      hwidLabel: req.body?.hwid_label,
      ip,
    });
    res.setHeader('Set-Cookie', cookie(req, issueToken(account), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true, username: account.username, role: account.role, account });
  } catch (error) {
    noteFailure(ip);
    sendError(res, error);
  }
}

app.post('/api/register', handleRegister);
// Alias histórico: el panel viejo llamaba setup al alta inicial.
app.post('/api/setup', handleRegister);

/** Reata una cuenta a un dispositivo nuevo con contraseña + key de acceso. */
app.post('/api/recover-device', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto' });
  }
  try {
    const account = await accounts.rebindDevice({
      username: req.body?.username,
      password: req.body?.password,
      key: req.body?.key,
      hwid: req.body?.hwid,
      hwidLabel: req.body?.hwid_label,
      ip,
    });
    res.setHeader('Set-Cookie', cookie(req, issueToken(account), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true, username: account.username, role: account.role, account });
  } catch (error) {
    noteFailure(ip);
    sendError(res, error);
  }
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookie(req, '', 0));
  res.json({ ok: true });
});

app.get('/api/session', async (req, res) => {
  let auth = null;
  let dbIssue = null;

  try {
    auth = await currentAuth(req);
  } catch (error) {
    dbIssue = error.message;
  }

  let needsSetup = false;
  try {
    needsSetup = !(await accounts.hasAny()) && !settings.hasAccount();
  } catch (error) {
    dbIssue = dbIssue || error.message;
  }

  res.json({
    authed: Boolean(auth),
    authType: auth?.type ?? null,
    username: auth?.account?.username ?? null,
    role: auth?.account?.role ?? null,
    needsSetup,
    configured: settings.publicView().configured,
    registration: {
      requiresKey: true,
      hasAccounts: dbIssue ? null : !needsSetup,
    },
    dbError: dbIssue,
  });
});

/* --------------------------------------------------------------- setup ---- */

app.get('/api/setup', async (req, res) => {
  try {
    const view = settings.publicView();
    res.json({
      needsSetup: !(await accounts.hasAny()) && !settings.hasAccount(),
      configured: view.configured,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/account', requireAuth, requireSession, async (req, res) => {
  try {
    const legacy = settings.accountView();
    if (legacy.source === 'env' && legacy.username === req.auth.account.username) {
      return res.status(409).json({
        error: 'La cuenta viene de DASHBOARD_USERNAME / DASHBOARD_PASSWORD; cambiala en el deploy',
      });
    }
    const result = await accounts.changeAccount(req.auth.account.username, req.body?.current, {
      username: req.body?.username,
      password: req.body?.password,
    });
    res.setHeader('Set-Cookie', cookie(req, issueToken(result), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true, username: result.username, account: result });
  } catch (error) {
    sendError(res, error);
  }
});

/** Desvincula el dispositivo actual. Cierra las sesiones abiertas de la cuenta. */
app.delete('/api/account/hwid', requireAuth, requireSession, async (req, res) => {
  try {
    const view = await accounts.resetHwid(req.auth.account.username, req.body?.password);
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true, account: view });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/registration-key', requireAuth, requireSession, (req, res) => {
  if (req.auth.account.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el administrador puede ver la key de acceso' });
  }
  res.json(settings.registrationKeyView());
});

/* ---------------------------------------------------------------- keys ---- */

app.get('/api/keys', requireAuth, requireSession, (req, res) => {
  res.json({ keys: settings.listKeys() });
});

app.post('/api/keys', requireAuth, requireSession, (req, res) => {
  try {
    const created = settings.createKey(req.body?.name);
    res.json({ ok: true, token: created.token, key: created.key });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/keys/:id', requireAuth, requireSession, (req, res) => {
  try {
    settings.revokeKey(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

/* --------------------------------------------------------------- helpers -- */

function sendError(res, error) {
  const code = error?.code;
  if (code === 'not_configured' || code === 'db_unavailable' || code === 'invalid_config' || code === 'network') {
    return res.status(503).json({ error: error.message, code });
  }
  if (code === 'bad_credentials') return res.status(401).json({ error: error.message, code });
  if (code === 'bad_key' || code === 'hwid_mismatch') return res.status(403).json({ error: error.message, code });
  if (code === 'exists' || code === 'busy') return res.status(409).json({ error: error.message, code });
  if (code === 'not_found') return res.status(404).json({ error: error.message, code });
  if (code === 'invalid' || code === 'invalid_token') return res.status(400).json({ error: error.message, code });
  if (code === 'io') return res.status(500).json({ error: error.message, code });
  return res.status(500).json({ error: error?.message || 'Error interno' });
}

function sanitizeSearch(value) {
  return String(value || '')
    .replace(/[,()*"'\\%_]/g, ' ')
    .trim()
    .slice(0, 120);
}

function isOnline(status) {
  return status === 'online' || status === 'idle' || status === 'dnd';
}

function snowflake(value) {
  const id = String(value || '').trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

// El panel refresca cada 20s por pestaña abierta; con 5s de cache alcanza para
// no castigar el free tier de Supabase con 9 counts por request.
const summaryCache = { at: 0, data: null };

function invalidateSummary() {
  summaryCache.at = 0;
  summaryCache.data = null;
}

/**
 * Respuesta base del resumen. Se devuelve también cuando la DB no responde, así
 * el panel sigue operativo y muestra el error real en vez de romperse.
 */
function emptySummary(extra = {}) {
  return {
    total24h: 0,
    targets: 0,
    online: 0,
    presence: {},
    activity: {},
    voice: {},
    avatars: {},
    byType: Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])),
    bot: botStatus(),
    queue: { pending: queue.size, dropped: queue.dropped },
    configured: settings.publicView().configured,
    ...extra,
  };
}

/* ------------------------------------------------------------- settings --- */

app.get('/api/settings', requireAuth, requireSession, (req, res) => {
  const view = settings.publicView();
  const account = req.auth.account;
  const legacy = settings.accountView();
  const lockedByEnv = legacy.source === 'env' && legacy.username === account.username;
  res.json({
    ...view,
    username: account.username,
    role: account.role || 'user',
    accountSource: lockedByEnv ? 'env' : account.legacy ? 'file' : 'database',
    hwidLinked: account.hwid_linked ?? null,
    hwidLabel: account.hwid_label ?? null,
    trackAll: config.trackAll,
    seedTargets: config.seedTargets,
    bot: botStatus(),
  });
});

/**
 * Guarda credenciales desde el panel. Reacciona en caliente: si cambió
 * Supabase, reconstruye el cliente y recarga targets; si cambió el token,
 * reconecta el gateway.
 */
app.put('/api/settings', requireAuth, requireSession, async (req, res) => {
  const before = settings.get();
  let after;
  try {
    after = settings.update(req.body || {});
  } catch (error) {
    return sendError(res, error);
  }

  const supabaseChanged =
    before.supabaseUrl !== after.supabaseUrl || before.supabaseKey !== after.supabaseKey;
  const tokenChanged = before.discordToken !== after.discordToken;

  let supabaseTest = null;
  if (supabaseChanged) {
    db.reset();
    invalidateSummary();
    supabaseTest = await db.probe();
    if (supabaseTest.ok) {
      await targets.refresh({ force: true });
    } else {
      console.error('[web] Supabase guardado pero la prueba falló:', supabaseTest.message);
    }
  }

  if (before.selfPresence !== after.selfPresence && after.selfPresence) {
    const instance = getClient();
    if (instance?.isReady?.()) {
      try {
        const pending = instance.user.setStatus(after.selfPresence);
        if (pending && typeof pending.catch === 'function') {
          pending.catch((error) => console.warn('[web] no se pudo aplicar el estado propio:', error.message));
        }
      } catch (error) {
        console.warn('[web] no se pudo aplicar el estado propio:', error.message);
      }
    }
  }

  let connectError = null;
  if (tokenChanged) {
    if (after.discordToken) {
      try {
        await startBot(after.discordToken);
      } catch (error) {
        connectError = error.message;
      }
    } else {
      await stopBot();
    }
  }

  const view = settings.publicView();
  res.json({
    ok: true,
    settings: { ...view, bot: botStatus() },
    supabaseTest,
    connectError,
    bot: botStatus(),
  });
});

/**
 * Prueba credenciales sin guardarlas. Acepta valores en el body para poder
 * validar antes de escribir: { supabaseUrl, supabaseKey, discordToken }.
 */
app.post('/api/settings/test', requireAuth, requireSession, async (req, res) => {
  const stored = settings.get();
  const results = {};

  let url = stored.supabaseUrl;
  let key = stored.supabaseKey;
  try {
    if (req.body?.supabaseUrl !== undefined) url = settings.sanitize('supabaseUrl', req.body.supabaseUrl);
    if (req.body?.supabaseKey !== undefined) key = settings.sanitize('supabaseKey', req.body.supabaseKey);
  } catch (error) {
    return sendError(res, error);
  }

  if (!url || !key) {
    results.supabase = { ok: false, message: 'Faltan URL o secret key' };
  } else {
    results.supabase = await db.probeCredentials(url, key);
  }

  const token = String(
    req.body?.discordToken !== undefined ? req.body.discordToken : stored.discordToken
  ).trim();

  if (!token) {
    results.discord = { ok: false, message: 'Falta el token' };
  } else {
    try {
      const response = await net.fetchWithRetry('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: token },
      }, { retries: 2, timeoutMs: 15_000, label: 'discord-token' });
      if (response.status === 200) {
        const user = await response.json();
        results.discord = {
          ok: true,
          message: `Token válido: ${user.global_name || user.username} (${user.id})`,
          user: { id: user.id, username: user.username, global_name: user.global_name ?? null },
        };
      } else {
        results.discord = { ok: false, message: `Discord respondió ${response.status}: token inválido o revocado` };
      }
    } catch (error) {
      results.discord = { ok: false, message: `No se pudo llegar a Discord: ${net.describe(error)}` };
    }
  }

  res.json({ ok: results.supabase.ok && results.discord.ok, results });
});

app.post('/api/bot/connect', requireAuth, requireSession, async (req, res) => {
  try {
    const token = req.body?.token ? String(req.body.token).trim() : undefined;
    await startBot(token);
    invalidateSummary();
    res.json({ ok: true, bot: botStatus() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/bot/disconnect', requireAuth, requireSession, async (req, res) => {
  await stopBot();
  invalidateSummary();
  res.json({ ok: true, bot: botStatus() });
});

/* --------------------------------------------------------------- routes --- */

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    bot: botStatus().connected,
    db: db.isConfigured(),
    targetsError: targets.status().error,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) {
      return res.json(emptySummary({ dbError: 'Supabase no está configurado' }));
    }

    if (summaryCache.data && Date.now() - summaryCache.at < 5000) {
      return res.json(summaryCache.data);
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const view = settings.publicView();

    const [total, targetRows, ...byType] = await Promise.all([
      db.getClient().from('events').select('id', { count: 'exact', head: true }).gte('created_at', since),
      targets.list(),
      ...EVENT_TYPES.map((type) =>
        db
          .getClient()
          .from('events')
          .select('id', { count: 'exact', head: true })
          .eq('event_type', type)
          .gte('created_at', since)
      ),
    ]);

    const counts = {};
    EVENT_TYPES.forEach((type, index) => {
      counts[type] = byType[index].count ?? 0;
    });

    const snapshot = getPresenceSnapshot();
    const details = getPresenceDetails();
    const voiceAll = getVoiceSnapshot();

    const presence = {};
    const activity = {};
    const voice = {};
    const avatars = {};
    for (const row of targetRows) {
      presence[row.user_id] = snapshot[row.user_id] ?? null;
      if (details[row.user_id]) activity[row.user_id] = details[row.user_id];
      if (voiceAll[row.user_id]) voice[row.user_id] = voiceAll[row.user_id];
      const profile = getProfile(row.user_id);
      avatars[row.user_id] = profile?.avatar_url || avatarUrl(row.user_id, null);
    }

    const payload = {
      total24h: total.count ?? 0,
      targets: targetRows.length,
      online: targetRows.filter((row) => isOnline(presence[row.user_id])).length,
      presence,
      activity,
      voice,
      avatars,
      byType: counts,
      bot: botStatus(),
      queue: { pending: queue.size, dropped: queue.dropped },
      configured: view.configured,
    };

    summaryCache.at = Date.now();
    summaryCache.data = payload;
    res.json(payload);
  } catch (error) {
    console.error('[web] resumen no disponible:', net.describe(error));
    res.json(emptySummary({ dbError: net.describe(error) }));
  }
});

app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const type = sanitizeSearch(req.query.type);
    const userId = sanitizeSearch(req.query.user);
    const guildId = sanitizeSearch(req.query.guild);
    const search = sanitizeSearch(req.query.q);

    let query = db
      .getClient()
      .from('events')
      .select('*')
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type === 'voice') {
      query = query.in('event_type', ['voice_join', 'voice_leave', 'voice_move', 'voice_stream', 'voice_camera']);
    } else if (type) {
      query = query.eq('event_type', type);
    }
    if (userId) query = query.eq('user_id', userId);
    if (guildId) query = query.eq('guild_id', guildId);
    if (search) {
      query = query.or(
        `username.ilike.%${search}%,content.ilike.%${search}%,old_content.ilike.%${search}%,channel_name.ilike.%${search}%`
      );
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    res.json({ events: data || [], next: (data || []).length === limit ? offset + limit : null });
  } catch (error) {
    console.error('[web] eventos no disponibles:', net.describe(error));
    res.json({ events: [], next: null, dbError: net.describe(error) });
  }
});

app.get('/api/targets', requireAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) return res.json({ targets: [], configured: false });
    res.json({ targets: await targets.list(), configured: true });
  } catch (error) {
    console.error('[web] objetivos no disponibles:', net.describe(error));
    res.json({ targets: [], configured: true, dbError: net.describe(error) });
  }
});

app.post('/api/targets', requireAuth, async (req, res) => {
  try {
    const userId = snowflake(req.body?.user_id);
    if (!userId) return res.status(400).json({ error: 'ID de Discord inválido' });

    let username = String(req.body?.username ?? '').trim();
    const note = String(req.body?.note ?? '').trim().slice(0, 200);

    // Si no vino el nombre, lo resolvemos con la cuenta conectada (o con el
    // último username que hayan dejado sus eventos).
    if (!username) {
      const client = getClient();
      if (client?.isReady?.()) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) {
          username = displayName(user);
          rememberProfile(user);
        }
      }
    }
    if (!username && db.isConfigured()) {
      const { data } = await db
        .getClient()
        .from('events')
        .select('username')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
      username = data?.[0]?.username ?? '';
    }

    await targets.add(userId, username, note);
    invalidateSummary();
    res.json({ ok: true, target: { user_id: userId, username: username || null, note: note || null } });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/targets/:userId', requireAuth, async (req, res) => {
  try {
    const userId = snowflake(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'ID de Discord inválido' });
    await targets.remove(userId);
    invalidateSummary();
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/guilds', requireAuth, (req, res) => {
  const client = getClient();
  const guilds = [...(client?.guilds?.cache?.values() || [])]
    .map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL?.({ size: 64 }) ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json({ guilds });
});

app.get('/api/members', requireAuth, async (req, res) => {
  try {
    const client = getClient();
    if (!client?.isReady?.()) return res.status(409).json({ error: 'El bot todavía no está conectado' });

    const guild = client.guilds.cache.get(String(req.query.guild || ''));
    if (!guild) return res.status(404).json({ error: 'Servidor no encontrado' });

    const search = sanitizeSearch(req.query.q).toLowerCase();
    let members = [...guild.members.cache.values()];

    if (!members.length || search) {
      try {
        const fetched = search
          ? await guild.members.fetch({ query: search, limit: 25 })
          : await guild.members.fetch({ limit: 100 });
        members = [...fetched.values()];
      } catch {
        // Sin permiso de member list: seguimos con la cache parcial.
      }
    }

    if (search) {
      members = members.filter((member) => {
        const username = (member.user?.username || '').toLowerCase();
        const nick = (member.displayName || '').toLowerCase();
        return username.includes(search) || nick.includes(search) || member.id.includes(search);
      });
    }

    res.json({
      members: members.slice(0, 50).map((member) => ({
        id: member.id,
        username: displayName(member.user),
        nickname: member.displayName || null,
        avatar_url: avatarUrl(member.id, member.user?.avatar ?? null),
        bot: Boolean(member.user?.bot),
      })),
    });
  } catch (error) {
    sendError(res, error);
  }
});

/* ------------------------------------------------------------------ SSE --- */

const streamClients = new Set();

queue.on('events', (rows) => {
  const payload = `data: ${JSON.stringify(rows)}\n\n`;
  for (const client of streamClients) {
    try {
      client.write(payload);
    } catch {
      streamClients.delete(client);
    }
  }
});

app.get('/api/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  streamClients.add(res);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    streamClients.delete(res);
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

/* ---------------------------------------------------------------- boot ---- */

function startServer(port = config.port) {
  const server = app.listen(port, () => {
    const address = server.address();
    const shown = address && typeof address === 'object' ? address.port : port;
    console.log(`[web] dashboard en http://localhost:${shown}`);
  });
  return server;
}

module.exports = { startServer, app, invalidateSummary };
