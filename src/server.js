'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const config = require('./config');
const db = require('./db');
const queue = require('./queue');
const targets = require('./targets');
const settings = require('./settings');
const {
  startBot,
  stopBot,
  getClient,
  getPresenceSnapshot,
  getPresenceDetails,
  getVoiceSnapshot,
  botStatus,
  displayName,
} = require('./bot');

const app = express();
const COOKIE_NAME = 'wt_session';
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

function issueToken() {
  const payload = String(Date.now() + SESSION_MS);
  return `${payload}.${sign(payload)}`;
}

function validToken(token) {
  if (!token) return false;
  const index = token.lastIndexOf('.');
  if (index < 1) return false;
  const payload = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expected = sign(payload);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return false;
  if (!crypto.timingSafeEqual(given, want)) return false;
  return Number(payload) > Date.now();
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

function requireAuth(req, res, next) {
  if (!validToken(readCookie(req, COOKIE_NAME))) {
    return res.status(401).json({ error: 'Sesión requerida' });
  }
  next();
}

const attempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 60_000;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  if (attempts.size > 5000) attempts.clear();
  return entry.count > 10;
}

function isLoopback(ip) {
  const value = String(ip || '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (rateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiados intentos, esperá un minuto' });
  }

  const password = String(req.body?.password ?? '');
  if (!settings.verifyPassword(password)) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  res.setHeader('Set-Cookie', cookie(req, issueToken(), Math.floor(SESSION_MS / 1000)));
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookie(req, '', 0));
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.json({
    authed: validToken(readCookie(req, COOKIE_NAME)),
    needsSetup: !settings.hasPassword(),
    configured: settings.publicView().configured,
  });
});

/* --------------------------------------------------------------- setup ---- */

app.get('/api/setup', (req, res) => {
  const view = settings.publicView();
  res.json({
    needsSetup: !view.hasPassword,
    remoteAllowed: config.allowRemoteSetup || isLoopback(req.ip),
    configured: view.configured,
  });
});

/**
 * Primer arranque: crear la contraseña del panel. Solo se acepta mientras no
 * haya ninguna, y solo desde loopback salvo que ALLOW_REMOTE_SETUP=true.
 */
app.post('/api/setup', (req, res) => {
  if (settings.hasPassword()) {
    return res.status(409).json({ error: 'El panel ya tiene contraseña' });
  }
  if (!config.allowRemoteSetup && !isLoopback(req.ip)) {
    return res.status(403).json({
      error: 'Por seguridad el primer setup solo se puede hacer desde localhost. Definí DASHBOARD_PASSWORD o ALLOW_REMOTE_SETUP=true.',
    });
  }

  try {
    settings.setPassword(req.body?.password);
    res.setHeader('Set-Cookie', cookie(req, issueToken(), Math.floor(SESSION_MS / 1000)));
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/password', requireAuth, (req, res) => {
  try {
    if (settings.publicView().passwordSource === 'env') {
      return res.status(409).json({ error: 'La contraseña viene de DASHBOARD_PASSWORD; cambiala ahí' });
    }
    settings.changePassword(req.body?.current, req.body?.next);
    res.json({ ok: true });
  } catch (error) {
    sendError(res, error);
  }
});

/* --------------------------------------------------------------- helpers -- */

function sendError(res, error) {
  const code = error?.code;
  if (code === 'not_configured') return res.status(503).json({ error: error.message, code });
  if (code === 'invalid' || code === 'invalid_token') return res.status(400).json({ error: error.message, code });
  if (code === 'busy') return res.status(409).json({ error: error.message, code });
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

/* ------------------------------------------------------------- settings --- */

app.get('/api/settings', requireAuth, (req, res) => {
  const view = settings.publicView();
  res.json({
    ...view,
    trackAll: config.trackAll,
    seedTargets: config.seedTargets,
    allowRemoteSetup: config.allowRemoteSetup,
    bot: botStatus(),
  });
});

/**
 * Guarda credenciales desde el panel. Reacciona en caliente: si cambió
 * Supabase, reconstruye el cliente y recarga targets; si cambió el token,
 * reconecta el gateway.
 */
app.put('/api/settings', requireAuth, async (req, res) => {
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

  if (supabaseChanged) {
    db.reset();
    invalidateSummary();
    void targets.refresh();
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
    connectError,
    bot: botStatus(),
  });
});

/**
 * Prueba credenciales sin guardarlas. Acepta valores en el body para poder
 * validar antes de escribir: { supabaseUrl, supabaseKey, discordToken }.
 */
app.post('/api/settings/test', requireAuth, async (req, res) => {
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
    try {
      const response = await fetch(`${url}/rest/v1/targets?select=user_id&limit=1`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (response.status === 200) {
        results.supabase = { ok: true, message: 'Conexión OK, tabla targets visible' };
      } else if (response.status === 401 || response.status === 403) {
        results.supabase = { ok: false, message: 'La secret key fue rechazada' };
      } else if (response.status === 404) {
        const body = await response.text();
        results.supabase = /relation|does not exist|42P01/i.test(body)
          ? { ok: false, message: 'Falta correr schema.sql en Supabase' }
          : { ok: false, message: `Supabase respondió ${response.status}` };
      } else {
        const body = (await response.text()).slice(0, 200);
        results.supabase = { ok: false, message: `Supabase respondió ${response.status}: ${body}` };
      }
    } catch (error) {
      results.supabase = { ok: false, message: `No se pudo llegar a Supabase: ${error.message}` };
    }
  }

  const token = String(
    req.body?.discordToken !== undefined ? req.body.discordToken : stored.discordToken
  ).trim();

  if (!token) {
    results.discord = { ok: false, message: 'Falta el token' };
  } else {
    try {
      const response = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: token },
      });
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
      results.discord = { ok: false, message: `No se pudo llegar a Discord: ${error.message}` };
    }
  }

  res.json({ ok: results.supabase.ok && results.discord.ok, results });
});

app.post('/api/bot/connect', requireAuth, async (req, res) => {
  try {
    const token = req.body?.token ? String(req.body.token).trim() : undefined;
    await startBot(token);
    invalidateSummary();
    res.json({ ok: true, bot: botStatus() });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/api/bot/disconnect', requireAuth, async (req, res) => {
  await stopBot();
  invalidateSummary();
  res.json({ ok: true, bot: botStatus() });
});

/* --------------------------------------------------------------- routes --- */

app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), bot: botStatus().connected });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const view = settings.publicView();
    if (!db.isConfigured()) {
      return res.json({
        total24h: 0,
        targets: 0,
        online: 0,
        presence: {},
        activity: {},
        voice: {},
        byType: Object.fromEntries(EVENT_TYPES.map((type) => [type, 0])),
        bot: botStatus(),
        queue: { pending: queue.size, dropped: queue.dropped },
        configured: view.configured,
      });
    }

    if (summaryCache.data && Date.now() - summaryCache.at < 5000) {
      return res.json(summaryCache.data);
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

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
    for (const row of targetRows) {
      presence[row.user_id] = snapshot[row.user_id] ?? null;
      if (details[row.user_id]) activity[row.user_id] = details[row.user_id];
      if (voiceAll[row.user_id]) voice[row.user_id] = voiceAll[row.user_id];
    }

    const payload = {
      total24h: total.count ?? 0,
      targets: targetRows.length,
      online: targetRows.filter((row) => isOnline(presence[row.user_id])).length,
      presence,
      activity,
      voice,
      byType: counts,
      bot: botStatus(),
      queue: { pending: queue.size, dropped: queue.dropped },
      configured: view.configured,
    };

    summaryCache.at = Date.now();
    summaryCache.data = payload;
    res.json(payload);
  } catch (error) {
    sendError(res, error);
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
    sendError(res, error);
  }
});

app.get('/api/targets', requireAuth, async (req, res) => {
  try {
    if (!db.isConfigured()) return res.json({ targets: [], configured: false });
    res.json({ targets: await targets.list(), configured: true });
  } catch (error) {
    sendError(res, error);
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
        if (user) username = displayName(user);
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
