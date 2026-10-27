'use strict';

const { Client } = require('discord.js-selfbot-v13');

const config = require('./config');
const queue = require('./queue');
const db = require('./db');
const net = require('./net');
const accounts = require('./accounts');
const targets = require('./targets');

/**
 * Un gateway por cuenta del panel. Cada usuario de la web pega su token, elige
 * sus objetivos y recibe sus propios eventos: nada se comparte entre owners.
 *
 * Los handlers convierten packets crudos del gateway en transiciones. El estado
 * anterior vive en Maps por runtime, no en la cache del library, que para
 * cuentas de usuario puede venir incompleta.
 */

const PRESENCE_RANK = { online: 4, idle: 3, dnd: 2, offline: 1, desconocido: 0 };
const MAX_MESSAGE_CACHE = 5000;
const MESSAGE_TTL_MS = 6 * 60 * 60 * 1000;
const RECOVERY_WARN_MS = 5 * 60 * 1000;

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

const CDN = 'https://cdn.discordapp.com';
const DEFAULT_AVATAR_COUNT = 6;

function hashExtension(hash) {
  return String(hash).startsWith('a_') ? 'gif' : 'webp';
}

function defaultAvatar(userId) {
  let index = 0;
  try {
    index = Number((BigInt(userId) >> 22n) % BigInt(DEFAULT_AVATAR_COUNT));
  } catch {
    index = 0;
  }
  return `${CDN}/embed/avatars/${index}.png`;
}

function avatarUrl(userId, hash, size = 128) {
  if (!userId) return null;
  if (!hash) return defaultAvatar(userId);
  return `${CDN}/avatars/${userId}/${hash}.${hashExtension(hash)}?size=${size}`;
}

function bannerUrl(userId, hash, size = 600) {
  if (!userId || !hash) return null;
  return `${CDN}/banners/${userId}/${hash}.${hashExtension(hash)}?size=${size}`;
}

function snapshotUser(user) {
  const id = user?.id;
  if (!id) return null;
  return {
    username: user.username ?? null,
    global_name: user.globalName ?? user.global_name ?? null,
    discriminator: user.discriminator ?? null,
    avatar: user.avatar ?? null,
    banner: user.banner ?? null,
    accent_color: user.accentColor ?? user.accent_color ?? null,
  };
}

function profileView(userId, snapshot) {
  if (!snapshot) return null;
  return {
    username: snapshot.username,
    global_name: snapshot.global_name,
    display: displayName({
      id: userId,
      username: snapshot.username,
      globalName: snapshot.global_name,
      discriminator: snapshot.discriminator,
    }),
    avatar_url: avatarUrl(userId, snapshot.avatar),
    banner_url: bannerUrl(userId, snapshot.banner),
    accent_color: snapshot.accent_color ?? null,
  };
}

function diffProfiles(before, after) {
  const changes = {};
  if (before.username !== after.username) {
    changes.username = { from: before.username, to: after.username };
  }
  if (before.global_name !== after.global_name) {
    changes.global_name = { from: before.global_name, to: after.global_name };
  }
  if (before.avatar !== after.avatar) {
    changes.avatar = { from: before.avatar, to: after.avatar };
  }
  if (before.banner !== after.banner) {
    changes.banner = { from: before.banner, to: after.banner };
  }
  return Object.keys(changes).length ? changes : null;
}

function describeProfileChanges(changes, afterView, nick) {
  const parts = [];
  if (changes.username) {
    parts.push(`nombre: ${changes.username.from ?? '—'} → ${changes.username.to ?? '—'}`);
  }
  if (changes.global_name) {
    parts.push(`display: ${changes.global_name.from ?? '—'} → ${changes.global_name.to ?? '—'}`);
  }
  if (changes.avatar) parts.push(afterView.avatar_url ? 'avatar actualizado' : 'avatar quitado');
  if (changes.banner) parts.push(afterView.banner_url ? 'banner actualizado' : 'banner quitado');
  if (nick) parts.push(`apodo: ${nick.from ?? '—'} → ${nick.to ?? '—'}`);
  return parts.join(' · ');
}

function formatSeconds(total) {
  const seconds = Math.max(0, Math.round(total));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${seconds}s`;
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

function invalidToken(message) {
  return Object.assign(new Error(message), { code: 'invalid_token' });
}

/* --------------------------------------------------------------- runtime -- */

class Runtime {
  constructor(owner) {
    this.owner = owner;
    this.client = null;
    this.lastError = null;
    this.connecting = false;
    this.tokenSeen = false;
    this.startedAt = null;
    this.lastAttemptAt = 0;

    // messageId -> { content, userId, username, ts }
    this.messageCache = new Map();
    // userId -> 'online' | 'idle' | 'dnd' | 'offline'
    this.presenceCache = new Map();
    // userId -> { status, activities, devices, platform, guildId, ts }
    this.presenceDetails = new Map();
    // `${guildId}:${userId}` -> { channelId, channelName, since, stream, video }
    this.voiceStates = new Map();
    // userId -> { username, global_name, ... } baseline de perfil
    this.profiles = new Map();
    // `${guildId}:${userId}` -> apodo
    this.nicknames = new Map();
    // mensajes ya encolados en esta corrida
    this.loggedMessages = new Set();
    this.recoveryWarnAt = 0;
  }

  push(event) {
    queue.push({ owner: this.owner, created_at: new Date().toISOString(), ...event });
  }

  async alert(text) {
    if (!config.alertWebhook) return;
    try {
      await fetch(config.alertWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
      });
    } catch (error) {
      console.error(`[alert:${this.owner}] webhook falló:`, error.message);
    }
  }

  channelName(guild, channelId) {
    if (!channelId) return null;
    return guild?.channels?.cache?.get(channelId)?.name ?? null;
  }

  resolveUser(guild, userId) {
    if (!userId) return null;
    return guild?.members?.cache?.get(userId)?.user
      ?? this.client?.users?.cache?.get(userId)
      ?? null;
  }

  async resolveUserAsync(guild, userId) {
    const cached = this.resolveUser(guild, userId);
    if (cached) return cached;
    if (!userId || !this.client) return null;
    try {
      return await this.client.users.fetch(userId);
    } catch {
      return null;
    }
  }

  rememberMessage(message) {
    if (!message?.id) return;
    this.messageCache.set(message.id, {
      content: message.content ?? '',
      userId: message.author?.id ?? null,
      username: displayName(message.author),
      ts: Date.now(),
    });
    if (this.messageCache.size <= MAX_MESSAGE_CACHE) return;

    const cutoff = Date.now() - MESSAGE_TTL_MS;
    for (const [id, value] of this.messageCache) {
      if (this.messageCache.size <= MAX_MESSAGE_CACHE * 0.8) break;
      if (value.ts < cutoff) this.messageCache.delete(id);
    }
    while (this.messageCache.size > MAX_MESSAGE_CACHE) {
      this.messageCache.delete(this.messageCache.keys().next().value);
    }
  }

  warnRecovery(error) {
    if (error?.code === 'not_configured') return;
    const now = Date.now();
    if (now - this.recoveryWarnAt < RECOVERY_WARN_MS) return;
    this.recoveryWarnAt = now;
    const problem = db.problemView();
    const reason = problem ? `${problem.code}: ${problem.message}` : error?.message || String(error);
    console.warn(`[bot:${this.owner}] no se pudo recuperar el mensaje original (${reason})`);
  }

  /**
   * Si el edit llegó sin contenido viejo se busca el original en events. Si la
   * base está marcada como caída no se consulta: evita repetir el error en cada
   * edición y deja el aviso una sola vez cada 5 minutos.
   */
  async findMessageRecord(messageId) {
    const cached = this.messageCache.get(messageId);
    if (cached) return cached;
    if (!messageId) return null;
    if (!db.isConfigured() || !db.isHealthy()) return null;

    let response;
    try {
      response = await db
        .getClient()
        .from('events')
        .select('content, user_id, username')
        .eq('owner', this.owner)
        .eq('message_id', messageId)
        .eq('event_type', 'message')
        .order('created_at', { ascending: true })
        .limit(1);
    } catch (error) {
      this.warnRecovery(error);
      return null;
    }

    if (response.error) {
      db.noteFailure(response.error);
      this.warnRecovery(response.error);
      return null;
    }

    const row = response.data?.[0];
    if (!row) return null;

    const record = {
      content: row.content ?? '',
      userId: row.user_id,
      username: row.username,
      ts: Date.now(),
    };
    this.messageCache.set(messageId, record);
    return record;
  }

  /* ------------------------------------------------------------ presencia -- */

  applyPresence(raw) {
    const userId = raw?.user?.id;
    if (!userId || userId === this.client?.user?.id) return null;

    const guildId = raw.guild_id ?? null;
    const status = normalizeStatus(raw.status);
    const activities = activityList(raw.activities);
    const platform = raw.client_status ?? {};
    const devices = Object.keys(platform);
    const previous = this.presenceCache.get(userId) ?? 'desconocido';

    this.presenceCache.set(userId, status);
    this.presenceDetails.set(userId, { status, activities, devices, platform, guildId, ts: Date.now() });

    return { userId, guildId, status, previous, activities, devices, platform };
  }

  async handlePresence(raw) {
    const change = this.applyPresence(raw);
    if (!change) return;
    // La misma transición llega una vez por guild en común: se loguea una sola.
    if (change.previous === change.status) return;
    if (!(await targets.isTarget(this.owner, change.userId))) return;
    if (change.previous === 'desconocido' && change.status === 'offline') return;

    const guild = change.guildId ? this.client.guilds.cache.get(change.guildId) : null;
    const user = await this.resolveUserAsync(guild, change.userId);
    const username = displayName(user);
    await targets.touch(this.owner, change.userId, username);

    this.push({
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
      void this.alert(`${username} se desconectó (${where})`);
    } else if (change.previous === 'offline' || change.previous === 'desconocido') {
      void this.alert(`${username} se conectó como ${change.status}${device} (${where})`);
    }
  }

  seedPresence() {
    for (const guild of this.client.guilds.cache.values()) {
      const presences = guild.presences?.cache;
      if (!presences) continue;

      for (const presence of presences.values()) {
        const userId = presence.userId ?? presence.user?.id;
        if (!userId || userId === this.client.user?.id) continue;

        const status = normalizeStatus(presence.status);
        if (presenceRank(status) < presenceRank(this.presenceCache.get(userId))) continue;

        this.presenceCache.set(userId, status);
        this.presenceDetails.set(userId, {
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

  presenceSnapshot() {
    return Object.fromEntries(this.presenceCache);
  }

  presenceDetailsSnapshot() {
    return Object.fromEntries(this.presenceDetails);
  }

  /* ----------------------------------------------------------------- voz -- */

  seedVoice() {
    for (const guild of this.client.guilds.cache.values()) {
      for (const state of guild.voiceStates?.cache?.values() ?? []) {
        if (!state.channelId || !state.id) continue;
        this.voiceStates.set(`${guild.id}:${state.id}`, {
          channelId: state.channelId,
          channelName: this.channelName(guild, state.channelId),
          since: null,
          stream: Boolean(state.streaming),
          video: Boolean(state.selfVideo),
        });
      }
    }
  }

  applyVoice(raw) {
    const guild = raw?.guild_id ? this.client.guilds.cache.get(raw.guild_id) : null;
    const userId = raw?.user_id;
    if (!guild || !userId || userId === this.client.user?.id) return null;

    const key = `${guild.id}:${userId}`;
    const previous = this.voiceStates.get(key) ?? {
      channelId: null,
      channelName: null,
      since: null,
      stream: false,
      video: false,
    };

    const nextId = raw.channel_id ?? null;
    const nextName = this.channelName(guild, nextId);
    const now = Date.now();

    if (!nextId) {
      this.voiceStates.delete(key);
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

    this.voiceStates.set(key, { channelId: nextId, channelName: nextName, since, stream, video });

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

  async handleVoice(raw) {
    const change = this.applyVoice(raw);
    if (!change || !change.action) return;
    if (!(await targets.isTarget(this.owner, change.userId))) return;

    const user = await this.resolveUserAsync(change.guild, change.userId);
    const username = displayName(user);
    await targets.touch(this.owner, change.userId, username);

    const base = {
      user_id: change.userId,
      username,
      guild_id: change.guild.id,
      guild_name: change.guild.name,
    };

    if (change.action === 'voice_join') {
      this.push({
        ...base,
        event_type: 'voice_join',
        channel_id: change.next.channelId,
        channel_name: change.next.channelName,
        metadata: { from: null, to: change.next.channelId },
      });
      void this.alert(`${username} entró a voz "${change.next.channelName ?? change.next.channelId}" (${change.guild.name})`);
      return;
    }

    if (change.action === 'voice_leave') {
      this.push({
        ...base,
        event_type: 'voice_leave',
        channel_id: change.previous.channelId,
        channel_name: change.previous.channelName,
        metadata: { from: change.previous.channelId, to: null, seconds: change.seconds },
      });
      const stayed = change.seconds ? ` después de ${formatSeconds(change.seconds)}` : '';
      void this.alert(`${username} salió de voz "${change.previous.channelName ?? change.previous.channelId}"${stayed} (${change.guild.name})`);
      return;
    }

    if (change.action === 'voice_move') {
      this.push({
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
      this.push({
        ...base,
        event_type: 'voice_stream',
        channel_id: change.next.channelId,
        channel_name: change.next.channelName,
        metadata: { streaming: change.stream, self_video: change.video },
      });
      void this.alert(change.stream
        ? `${username} empezó a transmitir en "${change.next.channelName ?? change.next.channelId}" (${change.guild.name})`
        : `${username} dejó de transmitir (${change.guild.name})`);
      return;
    }

    this.push({
      ...base,
      event_type: 'voice_camera',
      channel_id: change.next.channelId,
      channel_name: change.next.channelName,
      metadata: { camera: change.video, streaming: change.stream },
    });
  }

  voiceSnapshot() {
    const snapshot = {};
    for (const [key, state] of this.voiceStates) {
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

  /* -------------------------------------------------------------- perfil -- */

  async emitProfileEvent({ userId, before, after, changes, source, initial, guild, nick }) {
    const afterView = profileView(userId, after);
    const beforeView = before ? profileView(userId, before) : null;
    const username = afterView?.display ?? 'desconocido';

    const summary = initial
      ? `perfil inicial: ${username}`
      : describeProfileChanges(changes, afterView, nick);
    if (!summary) return;

    await targets.touch(this.owner, userId, username);

    this.push({
      event_type: 'profile_update',
      user_id: userId,
      username,
      guild_id: guild?.id ?? null,
      guild_name: guild?.name ?? null,
      content: summary.slice(0, 4000),
      metadata: {
        source,
        initial: Boolean(initial),
        changes,
        nick: nick ?? null,
        before: beforeView,
        after: afterView,
      },
    });

    if (!initial && (changes.username || changes.global_name)) {
      void this.alert(`${username} cambió de nombre (${beforeView?.display ?? '—'} → ${username})`);
    }
  }

  async handleUserUpdate(raw) {
    const userId = raw?.id;
    if (!userId || userId === this.client?.user?.id) return;

    const after = snapshotUser(raw);
    if (!after) return;

    const before = this.profiles.get(userId) ?? null;
    this.profiles.set(userId, after);

    if (!(await targets.isTarget(this.owner, userId))) return;
    const changes = before ? diffProfiles(before, after) : null;
    if (before && !changes) return;

    await this.emitProfileEvent({
      userId,
      before,
      after,
      changes: changes ?? {},
      source: 'user',
      initial: !before,
      guild: null,
      nick: null,
    });
  }

  async handleMemberUpdate(raw) {
    const guildId = raw?.guild_id;
    const user = raw?.user;
    const userId = user?.id;
    if (!guildId || !userId || userId === this.client?.user?.id) return;

    const guild = this.client.guilds.cache.get(guildId) ?? null;
    const key = `${guildId}:${userId}`;

    const nickKnown = this.nicknames.has(key);
    const previousNick = this.nicknames.get(key) ?? null;
    const nextNick = raw.nick ?? null;
    this.nicknames.set(key, nextNick);

    const embedded = user.username ? snapshotUser(user) : null;
    const before = this.profiles.get(userId) ?? null;
    const after = embedded ?? before;
    if (embedded) this.profiles.set(userId, embedded);
    if (!after) return;

    if (!(await targets.isTarget(this.owner, userId))) return;

    const changes = before ? diffProfiles(before, after) : null;
    const nickChange = nickKnown && previousNick !== nextNick
      ? { from: previousNick, to: nextNick }
      : null;
    if (!changes && !nickChange) return;

    await this.emitProfileEvent({
      userId,
      before,
      after,
      changes: changes ?? {},
      source: 'member',
      initial: !before,
      guild,
      nick: nickChange,
    });
  }

  seedProfiles() {
    for (const user of this.client.users.cache.values()) {
      const snapshot = snapshotUser(user);
      if (snapshot) this.profiles.set(user.id, snapshot);
    }
    for (const guild of this.client.guilds.cache.values()) {
      for (const member of guild.members?.cache?.values() ?? []) {
        const userId = member.id ?? member.user?.id;
        if (!userId) continue;
        if (member.user) {
          const snapshot = snapshotUser(member.user);
          if (snapshot) this.profiles.set(userId, snapshot);
        }
        this.nicknames.set(`${guild.id}:${userId}`, member.nick ?? null);
      }
    }
  }

  getProfile(userId) {
    let snapshot = this.profiles.get(userId) ?? null;
    if (!snapshot && this.client) {
      const user = this.client.users?.cache?.get(userId);
      if (user) {
        snapshot = snapshotUser(user);
        if (snapshot) this.profiles.set(userId, snapshot);
      }
    }
    return snapshot ? profileView(userId, snapshot) : null;
  }

  rememberProfile(user) {
    const snapshot = snapshotUser(user);
    if (!snapshot) return null;
    this.profiles.set(user.id, snapshot);
    return profileView(user.id, snapshot);
  }

  /* ------------------------------------------------------------ mensajes -- */

  trackLogged(messageId) {
    if (!messageId) return false;
    if (this.loggedMessages.has(messageId)) return true;
    this.loggedMessages.add(messageId);
    if (this.loggedMessages.size > 5000) {
      this.loggedMessages.delete(this.loggedMessages.values().next().value);
    }
    return false;
  }

  async handleMessage(message) {
    if (!message?.guild || !message.author) return;
    if (message.author.id === this.client?.user?.id) return;
    if (message.system) return;
    if (this.trackLogged(message.id)) return;
    if (!(await targets.isTarget(this.owner, message.author.id))) return;

    this.rememberMessage(message);
    await targets.touch(this.owner, message.author.id, displayName(message.author));

    this.push({
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

  async handleMessageUpdate(oldMessage, newMessage) {
    if (!newMessage?.guild) return;
    // Updates parciales (solo embed) no traen contenido: no hay edit real.
    if (newMessage.content == null) return;

    const record = await this.findMessageRecord(newMessage.id);
    const author = newMessage.author ?? oldMessage?.author ?? null;
    const userId = author?.id ?? record?.userId;
    if (!userId) return;
    if (!(await targets.isTarget(this.owner, userId))) return;

    const before = oldMessage?.content ?? record?.content ?? '';
    const after = newMessage.content ?? '';
    if (before === after) return;

    const originalKnown = Boolean(record) || oldMessage?.content != null;
    const username = author ? displayName(author) : record?.username ?? 'desconocido';

    this.rememberMessage({
      id: newMessage.id,
      content: after,
      author: author ?? { id: userId, username },
    });
    await targets.touch(this.owner, userId, username);

    this.push({
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

  async handleMessageDelete(message) {
    if (!message?.guild) return;

    const record = await this.findMessageRecord(message.id);
    const author = message.author ?? null;
    const userId = author?.id ?? record?.userId;
    if (!userId) return;
    if (!(await targets.isTarget(this.owner, userId))) return;

    this.push({
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

    this.messageCache.delete(message.id);
  }

  async handleMessageDeleteBulk(messages) {
    if (!messages) return;
    const entries = typeof messages.values === 'function' ? [...messages.values()] : [...messages];
    for (const entry of entries.slice(0, 100)) {
      if (!entry) continue;
      try {
        await this.handleMessageDelete(entry);
      } catch (error) {
        console.error(`[bot:${this.owner}] bulk delete falló:`, error.message);
      }
    }
  }

  /* ----------------------------------------------------------- lifecycle -- */

  async onReady() {
    this.lastError = null;
    this.startedAt = Date.now();
    const user = this.client.user;
    console.log(`[bot:${this.owner}] conectado como ${displayName(user)} (${user.id}) · ${this.client.guilds.cache.size} servidores`);

    this.seedPresence();
    this.seedVoice();
    this.seedProfiles();

    if (config.selfPresence) {
      try {
        const pending = this.client.user.setStatus(config.selfPresence);
        if (pending && typeof pending.catch === 'function') {
          pending.catch((error) => console.warn(`[bot:${this.owner}] estado propio:`, error.message));
        }
      } catch (error) {
        console.warn(`[bot:${this.owner}] estado propio:`, error.message);
      }
    }

    accounts
      .saveDiscordIdentity(this.owner, {
        userId: user.id,
        username: displayName(user),
        avatar: avatarUrl(user.id, user.avatar, 128),
      })
      .catch((error) => console.warn(`[bot:${this.owner}] no se pudo guardar la identidad:`, error.message));

    await targets.refresh(this.owner, { force: true });
  }

  guard(handler) {
    return (...args) => {
      Promise.resolve(handler.apply(this, args)).catch((error) => {
        console.error(`[bot:${this.owner}] ${handler.name || 'handler'} falló:`, error.message);
      });
    };
  }

  async onRawPacket(packet) {
    if (!packet || typeof packet !== 'object') return;
    if (packet.t === 'PRESENCE_UPDATE') return this.handlePresence(packet.d);
    if (packet.t === 'VOICE_STATE_UPDATE') return this.handleVoice(packet.d);
    if (packet.t === 'USER_UPDATE') return this.handleUserUpdate(packet.d);
    if (packet.t === 'GUILD_MEMBER_UPDATE') return this.handleMemberUpdate(packet.d);
  }

  wire(instance) {
    instance.on('ready', this.guard(this.onReady));
    instance.on('raw', this.guard(this.onRawPacket));
    instance.on('messageCreate', this.guard(this.handleMessage));
    instance.on('messageUpdate', this.guard(this.handleMessageUpdate));
    instance.on('messageDelete', this.guard(this.handleMessageDelete));
    instance.on('messageDeleteBulk', this.guard(this.handleMessageDeleteBulk));

    instance.on('error', (error) => {
      this.lastError = error.message;
      console.error(`[bot:${this.owner}] error:`, error.message);
    });
    instance.on('disconnect', () => console.warn(`[bot:${this.owner}] gateway desconectado`));
    instance.on('reconnecting', () => console.warn(`[bot:${this.owner}] reconectando...`));
  }

  async start(token) {
    if (this.connecting) throw Object.assign(new Error('Ya hay una conexión en curso'), { code: 'busy' });

    const value = String(token || '').trim();
    if (!value) throw Object.assign(new Error('Falta el token de Discord'), { code: 'not_configured' });

    this.connecting = true;
    this.tokenSeen = true;
    try {
      await this.stop();
      this.lastAttemptAt = Date.now();
      const instance = new Client({ checkUpdate: false });
      this.client = instance;
      this.wire(instance);
      await instance.login(value);
      this.lastError = null;
      return instance;
    } catch (error) {
      this.lastError = error.message;
      try {
        this.client?.destroy?.();
      } catch {
        // ya estaba muerto
      }
      this.client = null;
      throw loginError(error);
    } finally {
      this.connecting = false;
    }
  }

  /** Conecta con el token guardado. Sin token no hace nada. */
  async ensure() {
    if (this.client?.isReady?.() || this.connecting) return this.client;
    // Un token inválido no se reintenta en cada poll del panel.
    if (this.lastError && Date.now() - this.lastAttemptAt < 30_000) return null;
    const record = await accounts.getRecord(this.owner).catch(() => null);
    const token = record?.discord_token || '';
    if (!token) {
      this.tokenSeen = false;
      return null;
    }
    this.tokenSeen = true;
    this.lastAttemptAt = Date.now();
    return this.start(token);
  }

  async stop() {
    const instance = this.client;
    this.client = null;
    this.lastError = null;
    this.lastAttemptAt = 0;
    if (instance) {
      try {
        instance.destroy();
      } catch {
        // destroy sobre un cliente que nunca logueó tira: no importa
      }
    }
    this.presenceCache.clear();
    this.presenceDetails.clear();
    this.voiceStates.clear();
    this.profiles.clear();
    this.nicknames.clear();
    this.messageCache.clear();
    this.loggedMessages.clear();
    return true;
  }

  status() {
    return {
      connected: Boolean(this.client?.isReady?.()),
      connecting: this.connecting,
      configured: this.tokenSeen,
      error: this.lastError,
      user_id: this.client?.user?.id ?? null,
      username: this.client?.user ? displayName(this.client.user) : null,
      avatar_url: this.client?.user ? avatarUrl(this.client.user.id, this.client.user.avatar) : null,
      guilds: this.client?.guilds?.cache?.size ?? 0,
      queued: queue.size,
      dropped: queue.dropped,
    };
  }

  guilds() {
    const list = [...(this.client?.guilds?.cache?.values() || [])]
      .map((guild) => ({
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL?.({ size: 64 }) ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return list;
  }
}

/* ---------------------------------------------------------------- manager -- */

const runtimes = new Map();

function runtime(owner) {
  const key = String(owner || '').trim().toLowerCase();
  let instance = runtimes.get(key);
  if (!instance) {
    instance = new Runtime(key);
    runtimes.set(key, instance);
  }
  return instance;
}

async function ensure(owner) {
  return runtime(owner).ensure();
}

/** Conecta en segundo plano: el panel no espera al gateway. */
function kick(owner) {
  ensure(owner).catch((error) => {
    if (error.code === 'not_configured') return;
    console.warn(`[bot:${owner}] conexión falló:`, error.message);
  });
}

async function start(owner, token) {
  return runtime(owner).start(token);
}

function reconnect(owner) {
  const instance = runtime(owner);
  void instance
    .stop()
    .then(() => instance.ensure())
    .catch((error) => {
      if (error.code === 'not_configured') return;
      console.warn(`[bot:${owner}] reconexión falló:`, error.message);
    });
}

async function stop(owner) {
  const key = String(owner || '').trim().toLowerCase();
  const instance = runtimes.get(key);
  if (!instance) return true;
  return instance.stop();
}

/** Desconecta y libera el runtime de una cuenta que el admin borró. */
async function forget(owner) {
  const key = String(owner || '').trim().toLowerCase();
  const instance = runtimes.get(key);
  if (!instance) return false;
  await instance.stop().catch(() => {});
  runtimes.delete(key);
  return true;
}

async function stopAll() {
  const all = [...runtimes.values()];
  await Promise.all(all.map((instance) => instance.stop().catch(() => {})));
  return all.length;
}

async function startAll() {
  const rows = await accounts.listWithTokens();
  for (const row of rows) kick(row.username);
  return rows.length;
}

function getClient(owner) {
  const key = String(owner || '').trim().toLowerCase();
  return runtimes.get(key)?.client ?? null;
}

function snapshots(owner) {
  const key = String(owner || '').trim().toLowerCase();
  const instance = runtimes.get(key);
  if (!instance) {
    return { presence: {}, details: {}, voice: {} };
  }
  return {
    presence: instance.presenceSnapshot(),
    details: instance.presenceDetailsSnapshot(),
    voice: instance.voiceSnapshot(),
  };
}

function getProfile(owner, userId) {
  const key = String(owner || '').trim().toLowerCase();
  return runtimes.get(key)?.getProfile(userId) ?? null;
}

function rememberProfile(owner, user) {
  return runtime(owner).rememberProfile(user);
}

function status(owner) {
  const key = String(owner || '').trim().toLowerCase();
  const instance = runtimes.get(key);
  if (!instance) {
    return {
      connected: false,
      connecting: false,
      configured: false,
      error: null,
      user_id: null,
      username: null,
      avatar_url: null,
      guilds: 0,
      queued: queue.size,
      dropped: queue.dropped,
    };
  }
  return instance.status();
}

function guilds(owner) {
  const key = String(owner || '').trim().toLowerCase();
  return runtimes.get(key)?.guilds() ?? [];
}

/* ------------------------------------------------------- validación token -- */

let tokenValidator = null;

/** Devuelve { id, username, global_name, avatar } o tira invalid_token. */
async function validateToken(token) {
  const value = String(token || '').trim();
  if (!value) throw invalidToken('Falta el token de Discord');
  if (tokenValidator) return tokenValidator(value);

  let response;
  try {
    response = await net.fetchWithRetry('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: value },
    }, { retries: 2, timeoutMs: 12_000, label: 'discord-token' });
  } catch (error) {
    throw Object.assign(new Error(`No se pudo llegar a Discord: ${net.describe(error)}`), { code: 'network' });
  }

  if (response.status === 401 || response.status === 403) {
    throw invalidToken('Discord rechazó el token: está vencido, revocado o mal copiado');
  }
  if (response.status !== 200) {
    throw Object.assign(new Error(`Discord respondió ${response.status} al validar el token`), {
      code: 'login_failed',
    });
  }

  const user = await response.json();
  return {
    id: user.id,
    username: user.username,
    global_name: user.global_name ?? null,
    avatar: avatarUrl(user.id, user.avatar, 128),
  };
}

module.exports = {
  ensure,
  kick,
  start,
  reconnect,
  stop,
  forget,
  stopAll,
  startAll,
  getClient,
  status,
  snapshots,
  getProfile,
  rememberProfile,
  guilds,
  validateToken,
  avatarUrl,
  bannerUrl,
  displayName,
  // hooks de test
  __setClient: (owner, fake) => {
    const instance = runtime(owner);
    instance.client = fake || null;
    instance.tokenSeen = Boolean(fake);
    instance.lastError = null;
  },
  __setTokenValidator: (fn) => {
    tokenValidator = fn || null;
  },
  __runtime: (owner) => runtime(owner),
  __reset: async () => {
    await stopAll();
    runtimes.clear();
  },
};
