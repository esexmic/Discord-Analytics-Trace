'use strict';

const config = require('./config');
const net = require('./net');
const accounts = require('./accounts');

/**
 * Webhook de actividad por cuenta.
 *
 * El panel ya muestra los eventos en vivo; esto es ese mismo registro pero afuera,
 * en un canal de Discord. Cada cuenta pega su URL en Ajustes y el server la guarda
 * en la tabla `accounts`. Lo que se envía sale del mismo lote que alimenta el SSE,
 * así que lo que se ve en la página es lo que llega al webhook.
 *
 * El log se arma por evento, no por cuenta: el nombre que aparece es el del
 * objetivo del propio evento (`events.username`), así que dos objetivos seguidos
 * producen dos líneas con dos nombres distintos.
 *
 * Los eventos se agrupan (hasta 10 embeds por mensaje) porque un webhook de
 * Discord se ratea rápido. Si Discord rechaza la URL, la cuenta entra en cooldown
 * y se descarta lo acumulado: un webhook caído nunca puede frenar el pipeline del
 * bot ni la escritura de eventos.
 */

const NAME = 'Xyb Trace';
const AVATAR_PATH = '/logo.jpg';
const MAX_EMBEDS = 10;
const BUFFER_MAX = 60;
const FLUSH_MS = 1200;
const URL_TTL_MS = 30_000;
const RETRY_MS = 60_000;
const DROP_MS = 5 * 60_000;
const TEXT_MAX = 900;

const VERB = {
  message: 'Mensaje',
  message_edit: 'Mensaje editado',
  message_delete: 'Mensaje borrado',
  voice_join: 'Entró a voz',
  voice_leave: 'Salió de voz',
  voice_move: 'Cambio de canal de voz',
  voice_stream: 'Transmisión',
  voice_camera: 'Cámara',
  presence: 'Estado',
  profile_update: 'Perfil',
};

const GLYPH = {
  message: '✉',
  edit: '✎',
  delete: '✕',
  voice: '∿',
  presence: '●',
  profile: '☺',
};

const COLOR = {
  message: 0xa78bfa,
  edit: 0xffb4b6,
  delete: 0xffb4b6,
  voice: 0x7fd3ff,
  presence: 0x7ee2a0,
  profile: 0xcbb2ff,
};

const CLASS = {
  message: 'message',
  message_edit: 'edit',
  message_delete: 'delete',
  voice_join: 'voice',
  voice_leave: 'voice',
  voice_move: 'voice',
  voice_stream: 'voice',
  voice_camera: 'voice',
  presence: 'presence',
  profile_update: 'profile',
};

const STATUS = {
  online: 'en línea',
  idle: 'ausente',
  dnd: 'no molestar',
  offline: 'desconectado',
  invisible: 'invisible',
  desconocido: 'desconocido',
};

const buffers = new Map(); // owner -> { events, timer, url, urlAt, until, dropped }
let origin = config.publicUrl || '';
let send = post;

/* --------------------------------------------------------------- formato --- */

function clip(value, max = TEXT_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function label(value, fallback = '—') {
  return clip(value, 120) || fallback;
}

function statusLabel(value) {
  const raw = String(value ?? '').trim();
  return STATUS[raw.toLowerCase()] || label(raw, '—');
}

function duration(seconds) {
  const total = Number(seconds) || 0;
  if (total < 45) return '';
  if (total < 3600) return `${Math.round(total / 60)} min`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

/**
 * Link de Discord. Sólo se arma cuando el evento tiene guild y canal, que es lo
 * único que se puede abrir: un mensaje suma el id del mensaje. Presencia y perfil
 * no tienen canal, así que esos eventos salen sin link.
 */
function jumpLink(event) {
  const guildId = event.guild_id ? String(event.guild_id) : null;
  const channelId = event.channel_id ? String(event.channel_id) : null;
  if (!guildId || !channelId) return null;
  const messageId = event.message_id ? `/${String(event.message_id)}` : '';
  return `https://discord.com/channels/${guildId}/${channelId}${messageId}`;
}

function detail(event) {
  const meta = event.metadata || {};
  const channel = label(event.channel_name || event.channel_id, 'un canal');

  switch (event.event_type) {
    case 'message': {
      const extras = [];
      const attachments = Number(meta.attachments) || 0;
      const mentions = Number(meta.mentions) || 0;
      if (attachments) extras.push(`${attachments} adjunto${attachments === 1 ? '' : 's'}`);
      if (mentions) extras.push(`${mentions} mención${mentions === 1 ? '' : 'es'}`);
      if (meta.reply_to) extras.push('respondiendo a un mensaje');
      const text = clip(event.content);
      return [`> ${text || '(sin texto)'}`, extras.join(' · ')].filter(Boolean).join('\n');
    }
    case 'message_edit': {
      const before = clip(event.old_content)
        || (meta.original_known ? '(sin texto)' : '(el original no estaba registrado)');
      return `> antes: ${before}\n> ahora: ${clip(event.content) || '(vacío)'}`;
    }
    case 'message_delete':
      return `> ${clip(event.content) || '(sin texto)'}`;
    case 'voice_join':
      return `entró a **${channel}**`;
    case 'voice_leave': {
      const stayed = duration(meta.seconds);
      return `salió de **${channel}**${stayed ? ` · estuvo ${stayed}` : ''}`;
    }
    case 'voice_move': {
      const from = label(meta.from_name || meta.from, 'otro canal');
      const stayed = duration(meta.seconds);
      return `de **${from}** a **${channel}**${stayed ? ` · estuvo ${stayed} donde estaba` : ''}`;
    }
    case 'voice_stream':
      return meta.streaming
        ? `empezó a transmitir en **${channel}**`
        : `dejó de transmitir en **${channel}**`;
    case 'voice_camera':
      return meta.camera
        ? `prendió la cámara en **${channel}**`
        : `apagó la cámara en **${channel}**`;
    case 'presence': {
      const devices = Array.isArray(meta.devices) && meta.devices.length
        ? ` · desde ${meta.devices.join(' + ')}`
        : '';
      const activity = Array.isArray(meta.activities) && meta.activities[0]
        ? ` · jugando ${label(meta.activities[0].name, 'algo')}`
        : '';
      return `**${statusLabel(meta.from)} → ${statusLabel(meta.to)}**${devices}${activity}`;
    }
    case 'profile_update':
      return clip(event.content) || 'actualizó el perfil';
    default:
      return clip(event.content) || label(event.event_type);
  }
}

function fields(event) {
  const out = [];
  if (event.guild_id || event.guild_name) {
    out.push({ name: 'Servidor', value: label(event.guild_name, String(event.guild_id || '—')), inline: true });
  }
  if (event.channel_id || event.channel_name) {
    out.push({ name: 'Canal', value: label(event.channel_name || event.channel_id), inline: true });
  }
  out.push({ name: 'ID', value: `\`${label(event.user_id, '—')}\``, inline: true });
  return out;
}

function embed(event) {
  const cls = CLASS[event.event_type] || 'message';
  const link = jumpLink(event);
  const title = `${GLYPH[cls]} ${VERB[event.event_type] || label(event.event_type)} · ${label(event.username, 'objetivo')}`;
  const out = {
    title: title.slice(0, 250),
    description: detail(event).slice(0, 3800) || '(sin detalle)',
    color: COLOR[cls],
    fields: fields(event),
    timestamp: event.created_at || new Date().toISOString(),
  };
  if (link) out.url = link;
  return out;
}

/** Una sola línea legible, para el mensaje de prueba y para el log del server. */
function summarize(event) {
  const link = jumpLink(event);
  const where = label(event.guild_name, 'sin servidor');
  const base = `${VERB[event.event_type] || event.event_type} · ${label(event.username, 'objetivo')} (${where})`;
  return link ? `${base} ${link}` : base;
}

function message(events) {
  const out = {
    username: NAME,
    embeds: events.slice(0, MAX_EMBEDS).map(embed),
    allowed_mentions: { parse: [] },
  };
  if (origin) out.avatar_url = `${origin}${AVATAR_PATH}`;
  return out;
}

/* ---------------------------------------------------------------- envío ---- */

async function post(url, payload) {
  const response = await net.fetchWithRetry(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, { retries: 1, timeoutMs: 8000, label: 'webhook' });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw Object.assign(new Error(`HTTP ${response.status} ${clip(text, 160)}`.trim()), {
      status: response.status,
    });
  }
}

function slotFor(owner) {
  let slot = buffers.get(owner);
  if (!slot) {
    slot = { events: [], timer: null, busy: false, url: null, urlAt: 0, until: 0, dropped: 0 };
    buffers.set(owner, slot);
  }
  return slot;
}

async function resolveUrl(slot, owner) {
  if (slot.url && Date.now() - slot.urlAt < URL_TTL_MS) return slot.url;
  const url = await accounts.webhookUrl(owner);
  slot.url = url;
  slot.urlAt = Date.now();
  return url;
}

function schedule(slot, ms = FLUSH_MS) {
  if (slot.timer || slot.busy) return;
  slot.timer = setTimeout(() => {
    slot.timer = null;
    void flush(slot);
  }, ms);
  slot.timer.unref?.();
}

/** Mueve lo acumulado de una cuenta al webhook, de a hasta 10 embeds. */
async function flush(slot) {
  if (slot.busy) return;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  if (!slot.events.length) return;
  if (Date.now() < slot.until) {
    slot.events = [];
    return;
  }

  slot.busy = true;
  const batch = slot.events.splice(0, MAX_EMBEDS);
  try {
    const url = await resolveUrl(slot, batch[0].owner);
    if (!url) {
      // La cuenta no tiene webhook (o lo acaba de borrar): nada que enviar.
      slot.events = [];
      return;
    }
    try {
      await send(url, message(batch));
    } catch (error) {
      // 400/401/404 es una URL muerta: se pausa 5 min y se tira lo acumulado,
      // que para ese webhook ya no va a servir. Un fallo de red se reintenta.
      const dead = error.status === 400 || error.status === 401 || error.status === 404;
      slot.until = Date.now() + (dead ? DROP_MS : RETRY_MS);
      slot.events = [];
      slot.urlAt = 0;
      console.error(
        `[webhook:${batch[0].owner}] ${dead ? 'webhook rechazado, se pausa 5 min' : 'no se pudo enviar, se reintenta'} (${accounts.maskWebhook(url)}):`,
        error.message,
      );
      return;
    }
  } catch (error) {
    slot.events.unshift(...batch);
    slot.urlAt = 0;
    console.error(`[webhook:${batch[0].owner}] la base no devolvió la URL del webhook:`, error.message);
  } finally {
    slot.busy = false;
    if (slot.events.length && Date.now() >= slot.until) schedule(slot, 0);
  }
}

/** Lo que llega del gateway: se acumula por cuenta y se despacha en lotes. */
function offer(owner, event) {
  const slot = slotFor(owner);
  if (Date.now() < slot.until) return;

  slot.events.push(event);
  if (slot.events.length > BUFFER_MAX) {
    slot.events.shift();
    slot.dropped += 1;
    if (slot.dropped === 1 || slot.dropped % BUFFER_MAX === 0) {
      console.warn(`[webhook:${owner}] cola saturada, se descartaron ${slot.dropped} eventos`);
    }
  }
  if (slot.events.length >= MAX_EMBEDS) void flush(slot);
  else schedule(slot);
}

/** Conecta el despacho al buffer de escritura, que es lo único que emite eventos. */
function attach(queue) {
  queue.on('events', (rows) => {
    for (const row of rows || []) {
      const owner = String(row?.owner ?? '').trim().toLowerCase();
      if (owner) offer(owner, row);
    }
  });
}

/* ------------------------------------------------------------------ API ---- */

/** Cambió la URL de la cuenta: se tira la cache y lo acumulado del webhook viejo. */
function forget(owner) {
  const slot = buffers.get(String(owner ?? '').trim().toLowerCase());
  if (!slot) return;
  if (slot.timer) {
    clearTimeout(slot.timer);
    slot.timer = null;
  }
  slot.events = [];
  slot.url = null;
  slot.urlAt = 0;
  slot.until = 0;
}

/** El origen público va detrás del avatar; sin él el log igual se envía. */
function noteOrigin(value) {
  if (config.publicUrl) return;
  const next = String(value ?? '').trim().replace(/\/+$/, '');
  if (next && /^https?:\/\//.test(next)) origin = next;
}

function avatarUrl() {
  return origin ? `${origin}${AVATAR_PATH}` : null;
}

function sample(owner) {
  return {
    owner,
    event_type: 'message',
    user_id: '0'.repeat(18),
    username: 'objetivo de prueba',
    guild_name: 'servidor de prueba',
    content: 'Si esto llegó, el webhook de Xyb Trace está funcionando.',
    metadata: {},
    created_at: new Date().toISOString(),
  };
}

/** Prueba real: manda un evento de ejemplo y devuelve la línea que se vio. */
async function test(url, owner) {
  const event = sample(owner);
  const payload = message([event]);
  payload.content = 'Prueba de webhook';
  try {
    await send(url, payload);
  } catch (error) {
    throw Object.assign(new Error(error.status
      ? `El webhook rechazó el mensaje (HTTP ${error.status}); revisá que la URL siga vigente.`
      : `No se pudo contactar al webhook: ${error.message}`), { code: 'network' });
  }
  return summarize(event);
}

/** Vacía las colas al apagar el proceso (deploy, reinicio). */
async function drain(deadlineMs = 2000) {
  const until = Date.now() + deadlineMs;
  for (const slot of buffers.values()) {
    while (slot.events.length && Date.now() < until) {
      const before = slot.events.length;
      await flush(slot);
      if (slot.events.length >= before) break;
    }
  }
  return [...buffers.values()].reduce((sum, slot) => sum + slot.events.length, 0);
}

module.exports = {
  NAME,
  attach,
  drain,
  test,
  forget,
  noteOrigin,
  avatarUrl,
  embed,
  jumpLink,
  summarize,
  __setSend(next) {
    send = next || post;
  },
  __reset() {
    for (const slot of buffers.values()) {
      if (slot.timer) clearTimeout(slot.timer);
    }
    buffers.clear();
    origin = config.publicUrl || '';
    send = post;
  },
};
