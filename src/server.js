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
const bot = require('./bot');

const app = express();
const COOKIE_NAME = 'xyb_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const FEED_LIMIT = 60;
const SUMMARY_CACHE_MS = 4000;
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

function readToken(token) {
  if (!token) return null;
  if (revokedTokens.has(token)) return null;
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

/**
 * El token de sesión es un HMAC sin estado: borrar la cookie en el logout no
 * impide que una copia filtrada siga sirviendo hasta el vencimiento. Se
 * guardan los logout en memoria hasta que expiren.
 */
const revokedTokens = new Map(); // token -> exp
let revokedPruneAt = 0;

function revokeToken(token) {
  if (!token) return;
  const parsed = readToken(token);
  revokedTokens.set(token, Number(parsed?.exp) || Date.now() + SESSION_MS);

  const now = Date.now();
  if (now > revokedPruneAt || revokedTokens.size > 5000) {
    revokedPruneAt = now + 60_000;
    for (const [value, exp] of revokedTokens) {
      if (exp <= now) revokedTokens.delete(value);
    }
  }
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

async function currentAuth(req) {
  const payload = readToken(readCookie(req, COOKIE_NAME));
  if (!payload) return null;
  const account = await accounts.validateSession(payload.u, payload.v);
  return account ? { account } : null;
}

async function requireAuth(req, res, next) {
  try {
    const auth = await currentAuth(req);
    if (!auth) return res.status(401).json({ error: 'Iniciá sesión para continuar', code: 'unauthorized' });
    req.auth = auth;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

function ownerOf(req) {
  return req.auth.account.username;
}

function requireAdmin(req, res, next) {
  if (req.auth?.account?.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el admin puede gestionar cuentas', code: 'forbidden' });
  }
  return next();
}

/** Ip + navegador que se guardan en la cuenta para la vista del admin. */
function clientInfo(req) {
  return {
    ip: req.ip || null,
    userAgent: req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 240) : null,
  };
}

const attempts = new Map();
const MAX_ATTEMPTS = 12;
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

function startSession(req, res, account) {
  res.setHeader('Set-Cookie', cookie(req, issueToken(account), Math.floor(SESSION_MS / 1000)));
}

function loginPayload(account) {
  return {
    ok: true,
    username: account.username,
    role: account.role || 'user',
    account,
  };
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
      ...clientInfo(req),
    });
    startSession(req, res, account);
    bot.kick(account.username);
    res.json(loginPayload(account));
  } catch (error) {
    noteFailure(ip);
    sendError(res, error);
  }
});

app.post('/api/register', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto' });
  }

  try {
    const account = await accounts.register({
      username: req.body?.username,
      password: req.body?.password,
      hwid: req.body?.hwid,
      hwidLabel: req.body?.hwid_label,
      ...clientInfo(req),
    });
    startSession(req, res, account);
    res.json(loginPayload(account));
  } catch (error) {
    noteFailure(ip);
    sendError(res, error);
  }
});

app.post('/api/recover-device', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto' });
  }
  try {
    const account = await accounts.rebindDevice({
      username: req.body?.username,
      password: req.body?.password,
      hwid: req.body?.hwid,
      hwidLabel: req.body?.hwid_label,
      ...clientInfo(req),
    });
    startSession(req, res, account);
    bot.kick(account.username);
    res.json(loginPayload(account));
  } catch (error) {
    noteFailure(ip);
    sendError(res, error);
  }
});

app.post('/api/logout', (req, res) => {
  revokeToken(readCookie(req, COOKIE_NAME));
  res.setHeader('Set-Cookie', cookie(req, '', 0));
  res.json({ ok: true });
});

app.get('/api/session', async (req, res) => {
  try {
    const auth = await currentAuth(req);
    res.json({
      authed: Boolean(auth),
      username: auth?.account?.username ?? null,
      role: auth?.account?.role ?? null,
      account: auth?.account ?? null,
      db: dbState(),
    });
  } catch (error) {
    res.json({ authed: false, db: dbState(), error: error.message });
  }
});

/* ------------------------------------------------------------- resumen --- */

const summaries = new Map(); // owner -> { at, data }

function invalidateSummary(owner) {
  if (owner) summaries.delete(owner);
  else summaries.clear();
}

function dbState() {
  const problem = db.problemView();
  return {
    configured: db.isConfigured(),
    ok: db.isHealthy(),
    code: problem?.code || null,
    message: problem?.message || null,
  };
}

function emptySummary(owner, extra = {}) {
  return {
    total24h: 0,
    targets: 0,
    online: 0,
    presence: {},
    activity: {},
    voice: {},
    avatars: {},
    byType: Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])),
    bot: bot.status(owner),
    queue: { pending: queue.size, dropped: queue.dropped },
    approximate: false,
    ...extra,
  };
}

/**
 * Conteo de eventos en una sola consulta. Usa el RPC `event_stats` del schema
 * v2; si todavía no existe cae a traer los tipos (máximo 1000 filas de
 * PostgREST) y marca el resultado como aproximado.
 */
async function eventCounts(owner, since) {
  const client = db.getClient();
  if (typeof client.rpc === 'function') {
    const { data, error } = await client.rpc('event_stats', { p_owner: owner, p_since: since });
    if (!error) {
      const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0]));
      let total = 0;
      for (const row of data || []) {
        const type = row.event_type;
        const value = Number(row.total) || 0;
        total += value;
        if (type in counts) counts[type] = value;
        else counts[type] = value;
      }
      return { counts, total, approximate: false };
    }
    if (!/function|schema cache|PGRST202|42883/i.test(String(error.message || ''))) {
      throw new Error(error.message);
    }
  }

  const { data, error } = await client
    .from('events')
    .select('event_type')
    .eq('owner', owner)
    .gte('created_at', since)
    .limit(10000);
  if (error) throw new Error(error.message);

  const counts = Object.fromEntries(EVENT_TYPES.map((type) => [type, 0]));
  let total = 0;
  for (const row of data || []) {
    total += 1;
    counts[row.event_type] = (counts[row.event_type] || 0) + 1;
  }
  return { counts, total, approximate: true };
}

async function buildSummary(owner) {
  if (!db.isConfigured() || !db.isHealthy()) {
    const problem = db.problemView();
    return emptySummary(owner, {
      dbError: problem?.message || 'La base no está configurada',
    });
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [targetRows, counts] = await Promise.all([
    targets.list(owner),
    eventCounts(owner, since),
  ]);

  const snapshots = bot.snapshots(owner);
  const presence = {};
  const activity = {};
  const voice = {};
  const avatars = {};

  for (const row of targetRows) {
    const userId = String(row.user_id);
    presence[userId] = snapshots.presence[userId] ?? null;
    if (snapshots.details[userId]) activity[userId] = snapshots.details[userId];
    if (snapshots.voice[userId]) voice[userId] = snapshots.voice[userId];
    const profile = bot.getProfile(owner, userId);
    avatars[userId] = profile?.avatar_url || bot.avatarUrl(userId, null);
  }

  const online = targetRows.filter((row) => isOnline(presence[String(row.user_id)])).length;

  return {
    total24h: counts.total,
    targets: targetRows.length,
    online,
    presence,
    activity,
    voice,
    avatars,
    byType: counts.counts,
    bot: bot.status(owner),
    queue: { pending: queue.size, dropped: queue.dropped },
    approximate: counts.approximate,
  };
}

async function getSummary(owner) {
  const cached = summaries.get(owner);
  if (cached && Date.now() - cached.at < SUMMARY_CACHE_MS) return cached.data;
  const data = await buildSummary(owner);
  summaries.set(owner, { at: Date.now(), data });
  return data;
}

async function feedEvents(owner, { limit = FEED_LIMIT, offset = 0, type, userId, guildId, search } = {}) {
  let query = db
    .getClient()
    .from('events')
    .select('*')
    .eq('owner', owner)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);

  if (type === 'voice') {
    query = query.in('event_type', ['voice_join', 'voice_leave', 'voice_move', 'voice_stream', 'voice_camera']);
  } else if (type === 'message') {
    query = query.in('event_type', ['message', 'message_edit', 'message_delete']);
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
  return data || [];
}

/* --------------------------------------------------------------- helpers -- */

function sendError(res, error) {
  const code = error?.code;
  if (code === 'not_configured' || code === 'db_unavailable' || code === 'invalid_config'
    || code === 'network' || code === 'schema') {
    return res.status(503).json({ error: error.message, code });
  }
  if (code === 'bad_credentials' || code === 'unauthorized') {
    return res.status(401).json({ error: error.message, code });
  }
  if (code === 'hwid_mismatch' || code === 'blocked') return res.status(403).json({ error: error.message, code });
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

/* --------------------------------------------------------------- arranque -- */

app.get('/api/bootstrap', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  bot.kick(owner);
  // Cuenta como "usó la página". Se resuelve solo (throttle adentro) para no
  // escribir en la base ni frenar el arranque si la DB está caída.
  accounts.touchUsage(owner, clientInfo(req)).catch(() => {});

  const [targetRows, summary, events, guilds] = await Promise.all([
    targets.list(owner).catch((error) => {
      console.error('[web] objetivos no disponibles:', net.describe(error));
      return [];
    }),
    getSummary(owner).catch((error) => {
      console.error('[web] resumen no disponible:', net.describe(error));
      return emptySummary(owner, { dbError: net.describe(error) });
    }),
    db.isConfigured() && db.isHealthy()
      ? feedEvents(owner).catch((error) => {
        console.error('[web] eventos no disponibles:', net.describe(error));
        return [];
      })
      : Promise.resolve([]),
    Promise.resolve(bot.guilds(owner)),
  ]);

  const status = bot.status(owner);
  status.configured = Boolean(req.auth.account.hasToken) || status.configured;

  res.json({
    account: req.auth.account,
    bot: status,
    targets: targetRows,
    summary,
    events,
    next: events.length === FEED_LIMIT ? FEED_LIMIT : null,
    guilds,
    db: dbState(),
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: Math.round(process.uptime()),
    db: dbState(),
    targets: targets.status().size,
  });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

/* ---------------------------------------------------------------- datos --- */

app.get('/api/summary', requireAuth, async (req, res) => {
  res.json(await getSummary(ownerOf(req)));
});

app.get('/api/events', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const events = await feedEvents(owner, {
      limit,
      offset,
      type: sanitizeSearch(req.query.type),
      userId: sanitizeSearch(req.query.user),
      guildId: sanitizeSearch(req.query.guild),
      search: sanitizeSearch(req.query.q),
    });
    res.json({ events, next: events.length === limit ? offset + limit : null });
  } catch (error) {
    console.error('[web] eventos no disponibles:', net.describe(error));
    res.json({ events: [], next: null, dbError: net.describe(error) });
  }
});

app.get('/api/targets', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    if (!db.isConfigured()) return res.json({ targets: [], configured: false });
    res.json({ targets: await targets.list(owner), configured: true });
  } catch (error) {
    console.error('[web] objetivos no disponibles:', net.describe(error));
    res.json({ targets: [], configured: true, dbError: net.describe(error) });
  }
});

app.post('/api/targets', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const userId = snowflake(req.body?.user_id);
    if (!userId) return res.status(400).json({ error: 'ID de Discord inválido' });

    let username = String(req.body?.username ?? '').trim();
    const note = String(req.body?.note ?? '').trim().slice(0, 200);

    if (!username) {
      const client = bot.getClient(owner);
      if (client?.isReady?.()) {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) {
          username = bot.displayName(user);
          bot.rememberProfile(owner, user);
        }
      }
    }
    if (!username && db.isConfigured() && db.isHealthy()) {
      const { data } = await db
        .getClient()
        .from('events')
        .select('username')
        .eq('owner', owner)
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1);
      username = data?.[0]?.username ?? '';
    }

    await targets.add(owner, userId, username, note);
    invalidateSummary(owner);
    res.json({
      ok: true,
      target: {
        user_id: userId,
        username: username || null,
        note: note || null,
        created_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/targets/:userId', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const userId = snowflake(req.params.userId);
    if (!userId) return res.status(400).json({ error: 'ID de Discord inválido' });
    await targets.remove(owner, userId);
    invalidateSummary(owner);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.get('/api/guilds', requireAuth, (req, res) => {
  res.json({ guilds: bot.guilds(ownerOf(req)) });
});

app.get('/api/members', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const client = bot.getClient(owner);
    if (!client?.isReady?.()) return res.status(409).json({ error: 'Tu cuenta de Discord todavía no está conectada' });

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
        // Sin permiso de member list seguimos con la cache parcial.
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
        username: bot.displayName(member.user),
        nickname: member.displayName || null,
        avatar_url: bot.avatarUrl(member.id, member.user?.avatar ?? null),
        bot: Boolean(member.user?.bot),
      })),
    });
  } catch (error) {
    sendError(res, error);
  }
});

/* --------------------------------------------------------------- cuenta --- */

app.get('/api/settings', requireAuth, (req, res) => {
  const owner = ownerOf(req);
  const status = bot.status(owner);
  status.configured = Boolean(req.auth.account.hasToken) || status.configured;
  res.json({
    account: req.auth.account,
    bot: status,
    db: dbState(),
  });
});

app.put('/api/settings/token', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const token = String(req.body?.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'Pegá el token de Discord' });

    const user = await bot.validateToken(token);
    const record = await accounts.saveDiscord(owner, {
      token,
      userId: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar,
    });
    bot.reconnect(owner);
    invalidateSummary(owner);
    targets.refresh(owner, { force: true });

    const status = bot.status(owner);
    status.configured = true;
    res.json({
      ok: true,
      account: accounts.publicView(record),
      bot: status,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/settings/token', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    await accounts.clearDiscord(owner);
    await bot.stop(owner);
    invalidateSummary(owner);
    res.json({ ok: true, account: accounts.publicView(await accounts.getRecord(owner)) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/bot/reconnect', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    bot.reconnect(owner);
    res.json({ ok: true, bot: bot.status(owner) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/bot/disconnect', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  await bot.stop(owner);
  res.json({ ok: true, bot: bot.status(owner) });
});

app.put('/api/account', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const legacy = settings.accountView();
    if (legacy.source === 'env' && legacy.username === owner) {
      return res.status(409).json({
        error: 'La cuenta viene de DASHBOARD_USERNAME / DASHBOARD_PASSWORD; cambiala en el deploy',
      });
    }
    const result = await accounts.changeAccount(owner, req.body?.current, {
      password: req.body?.password,
    });
    startSession(req, res, result);
    res.json({ ok: true, username: result.username, account: result });
  } catch (error) {
    sendError(res, error);
  }
});

app.delete('/api/account/hwid', requireAuth, async (req, res) => {
  const owner = ownerOf(req);
  try {
    const view = await accounts.resetHwid(owner, req.body?.password);
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.json({ ok: true, account: view });
  } catch (error) {
    sendError(res, error);
  }
});

/* ------------------------------------------------------------------ SSE --- */

/** res -> owner. Cada stream recibe solo los eventos de su cuenta. */
const streamClients = new Map();

queue.on('events', (rows) => {
  if (!rows?.length) return;
  const byOwner = new Map();
  for (const row of rows) {
    if (!row?.owner) continue;
    if (!byOwner.has(row.owner)) byOwner.set(row.owner, []);
    byOwner.get(row.owner).push(row);
  }
  for (const [owner, list] of byOwner) {
    invalidateSummary(owner);
    const payload = `data: ${JSON.stringify(list)}\n\n`;
    for (const [res, clientOwner] of streamClients) {
      if (clientOwner !== owner) continue;
      try {
        res.write(payload);
      } catch {
        streamClients.delete(res);
      }
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
  streamClients.set(res, ownerOf(req));

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  ping.unref?.();
  req.on('close', () => {
    clearInterval(ping);
    streamClients.delete(res);
  });
});

/* ------------------------------------------------------------ admin ------- */

const ADMIN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Corta el SSE de una cuenta (bloqueo o borrado): que no vea eventos más. */
function dropStreams(owner) {
  for (const [res, clientOwner] of streamClients) {
    if (clientOwner !== owner) continue;
    try {
      res.end();
    } catch {
      // respuesta ya cerrada
    }
    streamClients.delete(res);
  }
}

/**
 * Eventos y objetivos por cuenta en una sola consulta (RPC `admin_usage` del
 * schema v3). Si el RPC no existe todavía, agrega en memoria sobre un techo de
 * 10k filas y marca el resultado como aproximado.
 */
async function adminUsage(since) {
  if (!db.isConfigured() || !db.isHealthy()) return { usage: new Map(), approximate: true };
  const client = db.getClient();

  if (typeof client.rpc === 'function') {
    const { data, error } = await client.rpc('admin_usage', { p_since: since });
    if (!error) {
      const usage = new Map();
      for (const row of data || []) {
        usage.set(String(row.owner), {
          events: Number(row.total) || 0,
          targets: Number(row.targets) || 0,
          last_event_at: row.last_event_at || null,
        });
      }
      return { usage, approximate: false };
    }
    if (!/function|schema cache|PGRST202|42883/i.test(String(error.message || ''))) {
      throw new Error(error.message);
    }
  }

  const [events, targets] = await Promise.all([
    client.from('events').select('owner, created_at').gte('created_at', since).limit(10000),
    client.from('targets').select('owner').limit(10000),
  ]);
  if (events.error || targets.error) {
    throw new Error(events.error?.message || targets.error?.message);
  }

  const usage = new Map();
  const bucket = (owner) => {
    const key = String(owner);
    if (!usage.has(key)) usage.set(key, { events: 0, targets: 0, last_event_at: null });
    return usage.get(key);
  };
  for (const row of events.data || []) {
    const entry = bucket(row.owner);
    entry.events += 1;
    if (!entry.last_event_at || String(row.created_at) > entry.last_event_at) {
      entry.last_event_at = row.created_at;
    }
  }
  for (const row of targets.data || []) bucket(row.owner).targets += 1;

  return { usage, approximate: true };
}

app.get('/api/admin/accounts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const since = new Date(Date.now() - ADMIN_WINDOW_MS).toISOString();
    const [rows, usageInfo] = await Promise.all([
      accounts.listAdmin(),
      adminUsage(since),
    ]);

    const legacy = settings.accountView();
    const legacyName = legacy.source !== 'none' && legacy.username ? String(legacy.username) : null;
    const known = new Set(rows.map((row) => String(row.username)));
    if (legacyName && !known.has(legacyName)) {
      rows.push({
        username: legacyName,
        role: 'admin',
        status: 'active',
        login_count: 0,
        boot_count: 0,
      });
    }

    const me = ownerOf(req);
    const admins = rows.filter((row) => (row.role || 'user') === 'admin').length;

    res.json({
      accounts: rows.map((row) => ({
        ...accounts.publicView(row),
        legacy: legacyName ? String(row.username) === legacyName : Boolean(row.legacy),
        self: String(row.username) === me,
        events_7d: usageInfo.usage.get(String(row.username))?.events ?? 0,
        targets: usageInfo.usage.get(String(row.username))?.targets ?? 0,
        last_event_at: usageInfo.usage.get(String(row.username))?.last_event_at ?? null,
      })),
      totals: {
        accounts: rows.length,
        admins,
        blocked: rows.filter((row) => (row.status || 'active') === 'blocked').length,
        withToken: rows.filter((row) => row.discord_token).length,
      },
      window: '7d',
      approximate: usageInfo.approximate,
      db: dbState(),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/admin/accounts/:username/status', requireAuth, requireAdmin, async (req, res) => {
  const target = String(req.params.username || '').toLowerCase();
  try {
    const status = String(req.body?.status || '');
    if (!['active', 'blocked'].includes(status)) {
      return res.status(400).json({ error: 'Estado inválido', code: 'invalid' });
    }
    if (status === 'blocked' && target === ownerOf(req)) {
      return res.status(409).json({ error: 'No podés bloquear tu propia cuenta' });
    }

    const account = await accounts.setStatus(target, status, req.body?.reason);
    invalidateSummary(target);
    if (status === 'blocked') dropStreams(target);
    res.json({ ok: true, account });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/admin/accounts/:username/role', requireAuth, requireAdmin, async (req, res) => {
  const target = String(req.params.username || '').toLowerCase();
  try {
    const role = String(req.body?.role || '');
    if (!['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Rol inválido', code: 'invalid' });
    }

    const rows = await accounts.listAdmin();
    const admins = rows.filter((row) => (row.role || 'user') === 'admin');
    if (role === 'user' && admins.length <= 1 && admins.some((row) => row.username === target)) {
      return res.status(409).json({ error: 'Tiene que quedar al menos un admin' });
    }

    res.json({ ok: true, account: await accounts.setRole(target, role) });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/admin/accounts/:username/password', requireAuth, requireAdmin, async (req, res) => {
  const target = String(req.params.username || '').toLowerCase();
  try {
    const legacy = settings.accountView();
    if (legacy.source !== 'none' && legacy.username === target) {
      return res.status(409).json({
        error: 'La cuenta del deploy cambia de contraseña en las variables del deploy, no acá',
      });
    }
    const account = await accounts.adminSetPassword(target, req.body?.password);
    invalidateSummary(target);
    dropStreams(target);
    res.json({ ok: true, account });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/admin/accounts/:username/unlink', requireAuth, requireAdmin, async (req, res) => {
  try {
    const account = await accounts.adminUnlinkHwid(String(req.params.username || '').toLowerCase());
    res.json({ ok: true, account });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Borra la cuenta y todo lo suyo: gateway, objetivos y eventos. No hay
 * deshacer, así que el panel pide confirmación explícita.
 */
app.delete('/api/admin/accounts/:username', requireAuth, requireAdmin, async (req, res) => {
  const target = String(req.params.username || '').toLowerCase();
  try {
    if (target === ownerOf(req)) {
      return res.status(409).json({ error: 'No podés borrar tu propia cuenta' });
    }

    const rows = await accounts.listAdmin();
    const admins = rows.filter((row) => (row.role || 'user') === 'admin');
    if (admins.length <= 1 && admins.some((row) => row.username === target)) {
      return res.status(409).json({ error: 'No podés borrar el único admin' });
    }

    await bot.forget(target);
    if (db.isConfigured()) {
      const client = db.getClient();
      const [targetsOut, eventsOut] = await Promise.all([
        client.from('targets').delete().eq('owner', target),
        client.from('events').delete().eq('owner', target),
      ]);
      const failure = targetsOut.error || eventsOut.error;
      if (failure) {
        db.noteFailure(failure);
        return res.status(503).json({ error: `La base no pudo borrar sus datos: ${failure.message}`, code: 'db_unavailable' });
      }
    }
    await accounts.removeAccount(target);

    targets.forget(target);
    invalidateSummary(target);
    dropStreams(target);
    res.json({ ok: true, removed: target });
  } catch (error) {
    sendError(res, error);
  }
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
