'use strict';

const { Client } = require('discord.js-selfbot-v13');
const queue = require('./queue');
const db = require('./db');
const settings = require('./settings');
const targets = require('./targets');

let client = null;
let lastError = null;
let connecting = false;

/**
 * Capas de estado en memoria. El gateway manda packets crudos (PRESENCE_UPDATE /
 * VOICE_STATE_UPDATE) y acá se convierten en transiciones: el estado anterior
 * vive en estos Map, no en la cache del library, que para cuentas de usuario
 * puede venir incompleta.
 */

// messageId -> { content, userId, username, ts }
const messageCache = new Map();
const MAX_MESSAGE_CACHE = 5000;
const MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;

// userId -> 'online' | 'idle' | 'dnd' | 'offline'
const presenceCache = new Map();
// userId -> { status, activities, devices, platform, guildId, ts }
const presenceDetails = new Map();

// `${guildId}:${userId}` -> { channelId, channelName, since, stream, video }
const voiceStates = new Map();

// ids de mensajes ya encolados en esta corrida (evita duplicados al reanudar)
const loggedMessages = new Set();

const PRESENCE_RANK = { online: 4, idle: 3, dnd: 2, offline: 1, desconocido: 0 };

function displayName(user) {
  if (!user) return 'desconocido';
  const base = user.globalName || user.username || user.id || 'desconocido';
  const discriminator = user.discriminator;
  return discriminator && discriminator !== '0' ? `${base}#${discriminator}` : base;
}

function normalizeStatus(status) {
  if (!status || status === 'invisible') return 'offline';
  return status;
}

function presenceRank(status) {
  return PRESENCE_RANK[normalizeStatus(status)] ?? 1;
}

function activityList(activities) {
  return (activities || [])
    .filter((activity) => activity && activity.name)
    .map((activity) => ({
      type: activity.type ?? null,
      name: activity.name,
      details: activity.details ?? null,
      state: activity.state ?? null,
      url: activity.url ?? null,
      emoji: activity.emoji?.name ?? null,
      timestamps: activity.timestamps ?? null,
    }));
}

function rememberMessage(message) {
  if (!message?.id) return;
  messageCache.set(message.id, {
    content: message.content ?? '',
    userId: message.author?.id ?? null,
    username: displayName(message.author),
    ts: Date.now(),
  });
  if (messageCache.size <= MAX_MESSAGE_CACHE) return;

  const cutoff = Date.now() - MESSAGE_TTL_MS;
  for (const [id, value] of messageCache) {
    if (messageCache.size <= MAX_MESSAGE_CACHE * 0.8) break;
    if (value.ts < cutoff) messageCache.delete(id);
  }
  while (messageCache.size > MAX_MESSAGE_CACHE) {
    messageCache.delete(messageCache.keys().next().value);
  }
}

/**
 * Si el edit llegó sin contenido viejo (mensaje anterior al arranque del bot, o
 * fuera de cache), se busca el original en la tabla events por message_id.
 */
async function findMessageRecord(messageId) {
  const cached = messageCache.get(messageId);
  if (cached) return cached;
  if (!messageId) return null;

  let response;
  try {
    response = await db
      .getClient()
      .from('events')
      .select('content, user_id, username')
      .eq('message_id', messageId)
      .eq('event_type', 'message')
      .order('created_at', { ascending: true })
      .limit(1);
  } catch (error) {
    if (error.code !== 'not_configured') {
      console.error('[bot] no se pudo recuperar el mensaje original:', error.message);
    }
    return null;
  }

  const { data, error } = response;
  if (error) {
    console.error('[bot] no se pudo recuperar el mensaje original:', error.message);
    return null;
  }

  const row = data?.[0];
  if (!row) return null;

  const record = {
    content: row.content ?? '',
    userId: row.user_id,
    username: row.username,
    ts: Date.now(),
  };
  messageCache.set(messageId, record);
  return record;
}

function channelName(guild, channelId) {
  if (!channelId) return null;
  return guild?.channels?.cache?.get(channelId)?.name ?? null;
}

function resolveUser(guild, userId) {
  if (!userId) return null;
  return guild?.members?.cache?.get(userId)?.user
    ?? client?.users?.cache?.get(userId)
    ?? null;
}

async function resolveUserAsync(guild, userId) {
  const cached = resolveUser(guild, userId);
  if (cached) return cached;
  if (!userId) return null;
  try {
    return await client.users.fetch(userId);
  } catch {
    return null;
  }
}

function push(event) {
  queue.push({ created_at: new Date().toISOString(), ...event });
}

async function alert(text) {
  const { alertWebhook } = settings.get();
  if (!alertWebhook) return;
  try {
    await fetch(alertWebhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
  } catch (error) {
    console.error('[alert] webhook falló:', error.message);
  }
}

/* ------------------------------------------------------------- presencia -- */

function applyPresence(raw) {
  const userId = raw?.user?.id;
  if (!userId || userId === client.user?.id) return null;

  const guildId = raw.guild_id ?? null;
  const status = normalizeStatus(raw.status);
  const activities = activityList(raw.activities);
  const platform = raw.client_status ?? {};
  const devices = Object.keys(platform);
  const previous = presenceCache.get(userId) ?? 'desconocido';

  presenceCache.set(userId, status);
  presenceDetails.set(userId, { status, activities, devices, platform, guildId, ts: Date.now() });

  return { userId, guildId, status, previous, activities, devices, platform };
}

async function handlePresence(raw) {
  const change = applyPresence(raw);
  if (!change) return;
  // Sin cambio real de estado no se loguea: la misma transición llega una vez
  // por cada guild en común y no queremos el feed repetido N veces.
  if (change.previous === change.status) return;
  if (!(await targets.isTarget(change.userId))) return;
  if (change.previous === 'desconocido' && change.status === 'offline') return;

  const guild = change.guildId ? client.guilds.cache.get(change.guildId) : null;
  const user = await resolveUserAsync(guild, change.userId);
  const username = displayName(user);
  await targets.touch(change.userId, username);

  push({
    event_type: 'presence',
    user_id: change.userId,
    username,
    guild_id: guild?.id ?? change.guildId,
    guild_name: guild?.name ?? null,
    metadata: {
      from: change.previous,
      to: change.status,
      activities: change.activities,
      devices: change.devices,
      platform: change.platform,
    },
  });

  const where = guild?.name ?? 'sin servidor';
  const device = change.devices.length ? ` desde ${change.devices.join(' + ')}` : '';
  if (change.status === 'offline') {
    void alert(`${username} se desconectó (${where})`);
  } else if (change.previous === 'offline' || change.previous === 'desconocido') {
    void alert(`${username} se conectó como ${change.status}${device} (${where})`);
  }
}

function seedPresence() {
  for (const guild of client.guilds.cache.values()) {
    const presences = guild.presences?.cache;
    if (!presences) continue;

    for (const presence of presences.values()) {
      const userId = presence.userId ?? presence.user?.id;
      if (!userId || userId === client.user?.id) continue;

      const status = normalizeStatus(presence.status);
      if (presenceRank(status) < presenceRank(presenceCache.get(userId))) continue;

      presenceCache.set(userId, status);
      presenceDetails.set(userId, {
        status,
        activities: activityList(presence.activities),
        devices: presence.clientStatus ? Object.keys(presence.clientStatus) : [],
        platform: presence.clientStatus ?? {},
        guildId: guild.id,
        ts: Date.now(),
      });
    }
  }
}

function getPresenceSnapshot() {
  return Object.fromEntries(presenceCache);
}

function getPresenceDetails() {
  return Object.fromEntries(presenceDetails);
}

/* ------------------------------------------------------------------ voz --- */

function seedVoice() {
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates?.cache?.values() ?? []) {
      if (!state.channelId || !state.id) continue;
      voiceStates.set(`${guild.id}:${state.id}`, {
        channelId: state.channelId,
        channelName: channelName(guild, state.channelId),
        since: null,
        stream: Boolean(state.streaming),
        video: Boolean(state.selfVideo),
      });
    }
  }
}

function applyVoice(raw) {
  const guild = raw?.guild_id ? client.guilds.cache.get(raw.guild_id) : null;
  const userId = raw?.user_id;
  if (!guild || !userId || userId === client.user?.id) return null;

  const key = `${guild.id}:${userId}`;
  const previous = voiceStates.get(key) ?? {
    channelId: null,
    channelName: null,
    since: null,
    stream: false,
    video: false,
  };

  const nextId = raw.channel_id ?? null;
  const nextName = channelName(guild, nextId);
  const now = Date.now();

  if (!nextId) {
    voiceStates.delete(key);
    return {
      guild,
      userId,
      action: previous.channelId ? 'voice_leave' : null,
      previous,
      next: { channelId: null, channelName: null },
      seconds: previous.since ? Math.max(0, Math.round((now - previous.since) / 1000)) : null,
      stream: false,
      video: false,
      selfMute: Boolean(raw.self_mute),
      selfDeaf: Boolean(raw.self_deaf),
    };
  }

  const moved = Boolean(previous.channelId) && previous.channelId !== nextId;
  const since = previous.channelId === nextId ? (previous.since ?? now) : now;
  const stream = Boolean(raw.self_stream);
  const video = Boolean(raw.self_video);

  voiceStates.set(key, { channelId: nextId, channelName: nextName, since, stream, video });

  let action = null;
  if (!previous.channelId) action = 'voice_join';
  else if (moved) action = 'voice_move';
  else if (stream !== Boolean(previous.stream)) action = 'voice_stream';
  else if (video !== Boolean(previous.video)) action = 'voice_camera';

  return {
    guild,
    userId,
    action,
    previous,
    next: { channelId: nextId, channelName: nextName },
    seconds: moved && previous.since ? Math.max(0, Math.round((now - previous.since) / 1000)) : null,
    stream,
    video,
    selfMute: Boolean(raw.self_mute),
    selfDeaf: Boolean(raw.self_deaf),
  };
}

async function handleVoice(raw) {
  const change = applyVoice(raw);
  if (!change || !change.action) return;
  if (!(await targets.isTarget(change.userId))) return;

  const user = await resolveUserAsync(change.guild, change.userId);
  const username = displayName(user);
  await targets.touch(change.userId, username);

  const base = {
    user_id: change.userId,
    username,
    guild_id: change.guild.id,
    guild_name: change.guild.name,
  };

  if (change.action === 'voice_join') {
    push({
      ...base,
      event_type: 'voice_join',
      channel_id: change.next.channelId,
      channel_name: change.next.channelName,
      metadata: { from: null, to: change.next.channelId },
    });
    void alert(`${username} entró a voz "${change.next.channelName ?? change.next.channelId}" (${change.guild.name})`);
    return;
  }

  if (change.action === 'voice_leave') {
    push({
      ...base,
      event_type: 'voice_leave',
      channel_id: change.previous.channelId,
      channel_name: change.previous.channelName,
      metadata: { from: change.previous.channelId, to: null, seconds: change.seconds },
    });
    const stayed = change.seconds ? ` después de ${formatSeconds(change.seconds)}` : '';
    void alert(`${username} salió de voz "${change.previous.channelName ?? change.previous.channelId}"${stayed} (${change.guild.name})`);
    return;
  }

  if (change.action === 'voice_move') {
    push({
      ...base,
      event_type: 'voice_move',
      channel_id: change.next.channelId,
      channel_name: change.next.channelName,
      metadata: {
        from: change.previous.channelId,
        to: change.next.channelId,
        from_name: change.previous.channelName,
        seconds: change.seconds,
      },
    });
    return;
  }

  if (change.action === 'voice_stream') {
    push({
      ...base,
      event_type: 'voice_stream',
      channel_id: change.next.channelId,
      channel_name: change.next.channelName,
      metadata: { streaming: change.stream, self_video: change.video },
    });
    void alert(change.stream
      ? `${username} empezó a transmitir en "${change.next.channelName ?? change.next.channelId}" (${change.guild.name})`
      : `${username} dejó de transmitir (${change.guild.name})`);
    return;
  }

  push({
    ...base,
    event_type: 'voice_camera',
    channel_id: change.next.channelId,
    channel_name: change.next.channelName,
    metadata: { camera: change.video, streaming: change.stream },
  });
}

function formatSeconds(total) {
  const seconds = Math.max(0, Math.round(total));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
}

function getVoiceSnapshot() {
  const snapshot = {};
  for (const [key, state] of voiceStates) {
    if (!state.channelId) continue;
    const [guildId, userId] = key.split(':');
    snapshot[userId] = {
      guild_id: guildId,
      channel_id: state.channelId,
      channel_name: state.channelName,
      since: state.since,
      streaming: state.stream,
      camera: state.video,
    };
  }
  return snapshot;
}

/* ------------------------------------------------------------- mensajes --- */

function trackLogged(messageId) {
  if (!messageId) return false;
  if (loggedMessages.has(messageId)) return true;
  loggedMessages.add(messageId);
  if (loggedMessages.size > 5000) {
    loggedMessages.delete(loggedMessages.values().next().value);
  }
  return false;
}

async function handleMessage(message) {
  if (!message?.guild || !message.author) return;
  if (message.author.id === client.user?.id) return;
  if (message.system) return;
  if (trackLogged(message.id)) return;
  if (!(await targets.isTarget(message.author.id))) return;

  rememberMessage(message);
  await targets.touch(message.author.id, displayName(message.author));

  push({
    event_type: 'message',
    message_id: message.id,
    user_id: message.author.id,
    username: displayName(message.author),
    guild_id: message.guild.id,
    guild_name: message.guild.name,
    channel_id: message.channel?.id ?? null,
    channel_name: message.channel?.name ?? null,
    content: (message.content ?? '').slice(0, 4000),
    metadata: {
      attachments: message.attachments?.size ?? 0,
      reply_to: message.reference?.messageId ?? null,
      mentions: message.mentions?.users?.size ?? 0,
    },
  });
}

async function handleMessageUpdate(oldMessage, newMessage) {
  if (!newMessage?.guild) return;
  // El library puede emitir updates parciales (solo embed): sin contenido no
  // hay edit real que registrar.
  if (newMessage.content == null) return;

  const record = await findMessageRecord(newMessage.id);
  const author = newMessage.author ?? oldMessage?.author ?? null;
  const userId = author?.id ?? record?.userId;
  if (!userId) return;
  if (!(await targets.isTarget(userId))) return;

  const before = oldMessage?.content ?? record?.content ?? '';
  const after = newMessage.content ?? '';
  if (before === after) return;

  const originalKnown = Boolean(record) || oldMessage?.content != null;
  const username = author ? displayName(author) : record?.username ?? 'desconocido';

  rememberMessage({
    id: newMessage.id,
    content: after,
    author: author ?? { id: userId, username },
  });
  await targets.touch(userId, username);

  push({
    event_type: 'message_edit',
    message_id: newMessage.id,
    user_id: userId,
    username,
    guild_id: newMessage.guild.id,
    guild_name: newMessage.guild.name,
    channel_id: newMessage.channel?.id ?? null,
    channel_name: newMessage.channel?.name ?? null,
    content: after.slice(0, 4000),
    old_content: before.slice(0, 4000),
    metadata: {
      original_known: originalKnown,
      attachments: newMessage.attachments?.size ?? 0,
    },
  });
}

async function handleMessageDelete(message) {
  if (!message?.guild) return;

  const record = await findMessageRecord(message.id);
  const author = message.author ?? null;
  const userId = author?.id ?? record?.userId;
  if (!userId) return;
  if (!(await targets.isTarget(userId))) return;

  push({
    event_type: 'message_delete',
    message_id: message.id,
    user_id: userId,
    username: author ? displayName(author) : record?.username ?? 'desconocido',
    guild_id: message.guild.id,
    guild_name: message.guild.name,
    channel_id: message.channel?.id ?? null,
    channel_name: message.channel?.name ?? null,
    content: (message.content ?? record?.content ?? '').slice(0, 4000),
    metadata: {},
  });

  messageCache.delete(message.id);
}

async function handleMessageDeleteBulk(messages) {
  if (!messages) return;
  const entries = typeof messages.values === 'function' ? [...messages.values()] : [...messages];
  for (const entry of entries.slice(0, 100)) {
    if (!entry) continue;
    try {
      await handleMessageDelete(entry);
    } catch (error) {
      console.error('[bot] bulk delete falló:', error.message);
    }
  }
}

/* -------------------------------------------------------------- lifecycle - */

async function onReady() {
  lastError = null;
  console.log(`[bot] conectado como ${displayName(client.user)} (${client.user.id})`);
  console.log(`[bot] servidores en cache: ${client.guilds.cache.size}`);

  seedPresence();
  seedVoice();

  const { selfPresence } = settings.get();
  if (selfPresence) {
    // setStatus no devuelve promesa en todas las versiones del library.
    try {
      const pending = client.user.setStatus(selfPresence);
      if (pending && typeof pending.catch === 'function') {
        pending.catch((error) => console.warn('[bot] no se pudo fijar el estado propio:', error.message));
      }
    } catch (error) {
      console.warn('[bot] no se pudo fijar el estado propio:', error.message);
    }
  }

  await targets.refresh();
}

function guard(handler) {
  return (...args) => {
    Promise.resolve(handler(...args)).catch((error) => {
      console.error(`[bot] ${handler.name || 'handler'} falló:`, error.message);
    });
  };
}

async function onRawPacket(packet) {
  if (!packet || typeof packet !== 'object') return;
  if (packet.t === 'PRESENCE_UPDATE') return handlePresence(packet.d);
  if (packet.t === 'VOICE_STATE_UPDATE') return handleVoice(packet.d);
}

function wire(instance) {
  instance.on('ready', guard(onReady));
  instance.on('raw', guard(onRawPacket));
  instance.on('messageCreate', guard(handleMessage));
  instance.on('messageUpdate', guard(handleMessageUpdate));
  instance.on('messageDelete', guard(handleMessageDelete));
  instance.on('messageDeleteBulk', guard(handleMessageDeleteBulk));

  instance.on('error', (error) => {
    lastError = error.message;
    console.error('[bot] error:', error.message);
  });
  instance.on('disconnect', () => console.warn('[bot] gateway desconectado'));
  instance.on('reconnecting', () => console.warn('[bot] reconectando...'));
}

function loginError(error) {
  const message = String(error?.message || error);
  if (/TOKEN_INVALID|invalid token|401|Unauthorized/i.test(message)) {
    return Object.assign(
      new Error('Discord rechazó el token: está vencido, revocado o mal copiado'),
      { code: 'invalid_token' }
    );
  }
  return Object.assign(new Error(`No se pudo conectar a Discord: ${message}`), { code: 'login_failed' });
}

/**
 * Conecta el gateway. Sin argumento usa el token guardado; con argumento prueba
 * ese token primero, así el panel puede validar antes de guardar.
 */
async function startBot(tokenOverride) {
  if (connecting) throw Object.assign(new Error('Ya hay una conexión en curso'), { code: 'busy' });

  const token = String(tokenOverride || settings.get().discordToken || '').trim();
  if (!token) throw Object.assign(new Error('Falta el token de Discord'), { code: 'not_configured' });

  connecting = true;
  try {
    await stopBot();
    const instance = new Client({ checkUpdate: false });
    client = instance;
    wire(instance);
    await instance.login(token);
    lastError = null;
    return instance;
  } catch (error) {
    lastError = error.message;
    try {
      client?.destroy?.();
    } catch {
      // ya estaba muerto
    }
    client = null;
    throw loginError(error);
  } finally {
    connecting = false;
  }
}

async function stopBot() {
  const instance = client;
  client = null;
  if (instance) {
    try {
      instance.destroy();
    } catch {
      // destroy sobre un cliente que nunca logueó tira: no importa
    }
  }
  presenceCache.clear();
  presenceDetails.clear();
  voiceStates.clear();
  messageCache.clear();
  loggedMessages.clear();
  return true;
}

async function restartBot() {
  await stopBot();
  const { discordToken } = settings.get();
  if (!discordToken) return null;
  return startBot(discordToken);
}

function botStatus() {
  const { discordToken } = settings.get();
  return {
    connected: Boolean(client?.isReady?.()),
    connecting,
    configured: Boolean(discordToken),
    error: lastError,
    user_id: client?.user?.id ?? null,
    username: client?.user ? displayName(client.user) : null,
    guilds: client?.guilds?.cache?.size ?? 0,
    queued: queue.size,
    dropped: queue.dropped,
  };
}

module.exports = {
  startBot,
  stopBot,
  restartBot,
  getClient: () => client,
  getPresenceSnapshot,
  getPresenceDetails,
  getVoiceSnapshot,
  botStatus,
  displayName,
  // exportados para el smoke test
  __setClient: (fake) => {
    client = fake;
  },
  __seed: () => {
    seedPresence();
    seedVoice();
  },
  handlePresence,
  handleVoice,
  handleMessage,
  handleMessageUpdate,
  handleMessageDelete,
};
