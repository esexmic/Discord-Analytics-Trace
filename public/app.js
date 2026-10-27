'use strict';

/* ------------------------------------------------------------------ dom -- */

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const show = (node, on) => node.classList.toggle('hidden', !on);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* --------------------------------------------------------------- estado -- */

const state = {
  account: null,
  bot: null,
  db: null,
  targets: [],
  events: [],
  guilds: [],
  summary: null,
  next: null,
  fetched: 0,
  type: '',
  guild: '',
  user: '',
  q: '',
  paused: false,
  source: null,
  streamDownSince: 0,
  feedSeq: 0,
  feedController: null,
  feedLoading: false,
  memberSeq: 0,
  memberController: null,
  authMode: 'login',
  recover: false,
  hwid: '',
  botTimer: 0,
  botBusy: false,
  wasConnected: false,
  toastTimer: 0,
  dbToastAt: 0,
  hwidReady: false,
  admin: null,
  adminSeq: 0,
  history: null,
};

const EVENT_TYPES = [
  'message', 'message_edit', 'message_delete',
  'voice_join', 'voice_leave', 'voice_move', 'voice_stream', 'voice_camera',
  'presence', 'profile_update',
];

/* ------------------------------------------------------------------ api -- */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, options = {}) {
  const init = {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    signal: options.signal,
    ...options,
  };
  if (init.body !== undefined && typeof init.body !== 'string') {
    init.body = JSON.stringify(init.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Sin conexión con el servidor', 0, 'network');
  }

  let data = null;
  const text = await response.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    throw new ApiError(data?.error || `Error ${response.status}`, response.status, data?.code || null);
  }
  return data || {};
}

/* ----------------------------------------------------------------- toast -- */

function toast(message, kind) {
  const node = $('toast');
  node.textContent = message;
  node.classList.toggle('is-bad', kind === 'bad');
  node.classList.add('is-on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => node.classList.remove('is-on'), 2600);
}

/* ------------------------------------------------------------------ hwid -- */

/**
 * Identidad del dispositivo: UUID de localStorage + huella del equipo,
 * pasada por SHA-256. Se calcula una sola vez por sesión y sólo cuando hace
 * falta (login, alta, recuperación), nunca en el arranque del panel.
 */
async function deviceHwid() {
  if (state.hwid) return state.hwid;

  let id = '';
  try {
    id = localStorage.getItem('xyb_device_id') || '';
    if (!id) {
      id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('xyb_device_id', id);
    }
  } catch {
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const raw = [
    id,
    navigator.userAgent,
    navigator.language,
    screen.width,
    screen.height,
    screen.colorDepth,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    navigator.hardwareConcurrency || 0,
    navigator.deviceMemory || 0,
    navigator.platform || '',
  ].join('|');

  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    state.hwid = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } else {
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i += 1) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    state.hwid = (hash >>> 0).toString(16).padStart(8, '0').repeat(8);
  }
  state.hwidReady = true;
  return state.hwid;
}

function deviceLabel() {
  const os = /Windows/i.test(navigator.platform || '') ? 'Windows'
    : /Mac|iPhone|iPad/i.test(navigator.platform || '') ? 'Apple'
      : /Linux/i.test(navigator.platform || '') ? 'Linux' : 'Navegador';
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge'
    : /Firefox\//.test(navigator.userAgent) ? 'Firefox'
      : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : 'Navegador';
  return `${os} · ${browser}`;
}

/* ----------------------------------------------------------------- time -- */

function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min}m`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `hace ${hour}h`;
  const day = Math.floor(hour / 24);
  if (day < 7) return `hace ${day}d`;
  return new Date(then).toLocaleDateString();
}

function clockTime(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  return new Date(then).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function snowflake(value) {
  const id = String(value || '').trim();
  return /^\d{17,20}$/.test(id) ? id : null;
}

function typeMatches(eventType, filter) {
  const type = String(eventType || '');
  if (!filter) return true;
  if (filter === 'voice') return type.startsWith('voice');
  if (filter === 'message') return type === 'message' || type.startsWith('message_');
  return type === filter;
}

/* ----------------------------------------------------------------- avata -- */

function initials(name) {
  const clean = String(name || '?').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s_.\-]+/).filter(Boolean);
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

function avatarInto(box, src, name) {
  const img = box.querySelector('img') || el('img');
  box.replaceChildren();
  if (src) {
    img.alt = '';
    img.hidden = false;
    img.src = src;
    img.onerror = () => { img.hidden = true; box.textContent = initials(name); };
    box.append(img);
  } else {
    box.textContent = initials(name);
  }
}

/* ---------------------------------------------------------------- auth --- */

const authForm = $('auth-card');

function setAuthMode(mode) {
  state.authMode = mode;
  state.recover = false;
  $('auth-title').textContent = mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta';
  $('auth-sub').textContent = mode === 'login'
    ? 'Tu cuenta, tu token, tu panel.'
    : 'Elegí usuario y contraseña. Después pegás tu token y listo.';
  $('auth-submit').textContent = mode === 'login' ? 'Entrar' : 'Crear cuenta';
  $('auth-repeat-wrap').classList.toggle('hidden', mode !== 'register');
  $('auth-recover-toggle').classList.toggle('hidden', mode !== 'login');
  $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  for (const b of $('auth-tabs').children) b.classList.toggle('is-on', b.dataset.mode === mode);
  authForm.reset();
  setAuthError('');
}

function setRecoverMode(on) {
  state.recover = on;
  $('auth-title').textContent = on ? 'Cambié de dispositivo' : 'Iniciar sesión';
  $('auth-sub').textContent = on
    ? 'Confirmá usuario y contraseña y vinculamos esta máquina.'
    : 'Tu cuenta, tu token, tu panel.';
  $('auth-submit').textContent = on ? 'Vincular dispositivo' : 'Entrar';
  $('auth-tabs').classList.toggle('hidden', on);
  $('auth-recover-toggle').classList.toggle('hidden', on);
  setAuthError('');
}

function setAuthError(message, hint) {
  $('auth-error').textContent = message || '';
  $('auth-device').textContent = hint || '';
}

async function submitAuth(event) {
  event.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;

  if (state.authMode === 'register' && password !== $('auth-repeat').value) {
    setAuthError('Las contraseñas no coinciden');
    return;
  }

  const button = $('auth-submit');
  button.disabled = true;
  setAuthError('');

  try {
    const hwid = await deviceHwid();
    const body = { username, password, hwid, hwid_label: deviceLabel() };
    const path = state.recover ? '/api/recover-device'
      : state.authMode === 'register' ? '/api/register' : '/api/login';
    const account = await api(path, { method: 'POST', body });
    enterApp(account.account || account);
  } catch (error) {
    if (error.code === 'hwid_mismatch') {
      setRecoverMode(true);
      setAuthError(error.message, 'Completá usuario y contraseña para vincular este equipo.');
    } else {
      setAuthError(error.message);
    }
  } finally {
    button.disabled = false;
  }
}

$('auth-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-mode]');
  if (button) setAuthMode(button.dataset.mode);
});
$('auth-recover-toggle').addEventListener('click', () => setRecoverMode(true));
authForm.addEventListener('submit', submitAuth);

/* -------------------------------------------------------------- render --- */

function botState() {
  const bot = state.bot || {};
  if (bot.connected) return { cls: 'dot--live', label: bot.username || 'Conectado' };
  if (bot.connecting) return { cls: 'dot--wait', label: 'Conectando…' };
  if (bot.configured) return { cls: 'dot--down', label: bot.error || 'Desconectado' };
  return { cls: '', label: 'Sin token' };
}

function renderBot() {
  const bot = state.bot || {};
  const view = botState();
  $('bot-dot').className = `dot ${view.cls}`;
  $('bot-name').textContent = bot.username || (bot.configured ? 'Conectando…' : 'Sin cuenta de Discord');
  const meta = bot.connected
    ? `${bot.guilds || 0} servidor${bot.guilds === 1 ? '' : 'es'} · en vivo`
    : bot.error || (bot.configured ? 'Estableciendo la sesión…' : 'Pegá tu token para empezar');
  $('bot-meta').textContent = meta;
  avatarInto($('bot-avatar'), bot.avatar_url, bot.username || '?');
}

function renderAccount() {
  const account = state.account || {};
  const discord = account.discord || {};
  $('set-discord-desc').textContent = discord.linked
    ? `Vinculado a ${discord.username || discord.user_id || 'tu cuenta'}. El token no se devuelve al navegador.`
    : 'Sin conectar. Pegá el token y queda guardado solo en tu cuenta.';
  $('set-hwid-desc').textContent = account.hwid_linked
    ? `Vinculado a ${account.hwid_label || 'un dispositivo'}.`
    : 'Sin dispositivo vinculado.';
  const webhook = account.webhook || {};
  $('set-wh-desc').textContent = webhook.configured
    ? `Activo en ${webhook.preview || 'un webhook de Discord'}. Cada evento llega al canal como registro de Xyb Trace, con el nombre del objetivo.`
    : 'Sin configurar. Pegá la URL de un webhook de Discord y el panel le manda el registro de actividad.';
  $('set-meta').textContent = `@${account.username || '—'} · rol ${account.role || 'user'} · último acceso ${
    account.last_login_at ? timeAgo(account.last_login_at) : '—'}`;
  show($('onboarding'), !discord.linked && !state.bot?.configured);
  if (account.role !== 'admin') {
    state.admin = null;
    show($('open-admin'), false);
    closeModal(admin);
  } else {
    show($('open-admin'), true);
  }
}

function renderTargets() {
  const list = $('targets');
  list.replaceChildren();

  if (!state.targets.length) {
    list.append(el('div', 'hint', 'Todavía no fijaste nadie. Pegá un ID de Discord o elegí un miembro del servidor.'));
  }

  for (const target of state.targets) {
    const userId = String(target.user_id);
    const row = el('div', 'target');
    if (state.user === userId) row.classList.add('is-active');
    if (target.pending) row.classList.add('is-pending');
    row.dataset.user = userId;
    row.tabIndex = 0;

    const avatar = el('div', 'target__avatar');
    avatarInto(avatar, target.avatar_url || (state.summary?.avatars || {})[userId], target.username || userId);

    const main = el('div', 'target__main');
    main.append(el('div', 'target__name', target.username || userId));
    main.append(el('div', 'target__meta', target.note ? `${userId} · ${target.note}` : userId));
    const activity = targetActivity(userId);
    if (activity) main.append(activity);

    const on = el('span', 'target__on');
    if (isOnline((state.summary?.presence || {})[userId])) on.classList.add('is-on');

    const remove = el('button', 'target__x', '✕');
    remove.type = 'button';
    remove.title = 'Dejar de seguir';
    remove.dataset.remove = userId;

    row.append(avatar, main, on, remove);
    list.append(row);
  }

  const count = String(state.targets.length);
  $('target-count').textContent = count;
  $('tabbar-count').textContent = count;
}

function isOnline(status) {
  return status === 'online' || status === 'idle' || status === 'dnd';
}

function targetActivity(userId) {
  const summary = state.summary || {};
  const node = el('div', 'target__activity');
  const bits = [];

  const voice = summary.voice?.[userId];
  if (voice?.channel_name || voice?.channel) {
    bits.push(el('span', 'voice', `en ${voice.channel_name || voice.channel}`));
  }
  const extras = [];
  if (voice?.streaming) extras.push('stream');
  if (voice?.camera) extras.push('cámara');
  if (extras.length) bits.push(el('span', 'device', extras.join(' + ')));

  if (!bits.length) {
    const details = summary.activity?.[userId];
    const label = Array.isArray(details?.activities)
      ? details.activities.map((activity) => activity?.name).filter(Boolean).join(' · ')
      : String(details || '');
    if (label) bits.push(el('span', '', label));
  }

  if (!bits.length) return null;
  node.append(...bits);
  return node;
}

function renderStats() {
  const summary = state.summary || {};
  $('stat-online').textContent = String(summary.online ?? 0);
  $('stat-targets').textContent = String(state.targets.length);
  $('stat-events').textContent = String(summary.total24h ?? 0);
  const voice = Object.keys(summary.voice || {}).length;
  $('stat-voice').textContent = String(voice);
}

function renderDb() {
  const db = state.db || {};
  const bad = db.configured && db.ok === false;
  const missing = db.configured === false;
  if (!bad && !missing) {
    show($('db-banner'), false);
    return;
  }
  $('db-banner').textContent = missing
    ? 'La base todavía no está configurada en el servidor. Avisale al dueño del panel.'
    : `Base sin respuesta: ${db.message || 'reintentando solo'}. Los eventos nuevos se encolan.`;
  show($('db-banner'), true);

  const now = Date.now();
  if (now - state.dbToastAt > 60_000) {
    state.dbToastAt = now;
    toast('Problema con la base, se reintenta solo', 'bad');
  }
}

/* -------------------------------------------------------------- eventos -- */

const TYPES = {
  message: { icon: '✉', cls: 'message', verb: 'escribió' },
  message_edit: { icon: '✎', cls: 'edit', verb: 'editó' },
  message_delete: { icon: '✕', cls: 'delete', verb: 'borró' },
  voice_join: { icon: '🎙', cls: 'voice', verb: 'entró a voice' },
  voice_leave: { icon: '⏏', cls: 'voice', verb: 'salió de voice' },
  voice_move: { icon: '⇄', cls: 'voice', verb: 'se movió de canal' },
  voice_stream: { icon: '▶', cls: 'voice', verb: 'cambió el stream' },
  voice_camera: { icon: '◉', cls: 'voice', verb: 'cambió la cámara' },
  presence: { icon: '●', cls: 'presence', verb: 'cambió de estado' },
  profile_update: { icon: '☺', cls: 'profile', verb: 'actualizó el perfil' },
};

const STATUS = {
  online: { label: 'en línea', cls: 'online' },
  idle: { label: 'ausente', cls: 'idle' },
  dnd: { label: 'no molestar', cls: 'dnd' },
  offline: { label: 'desconectado', cls: 'offline' },
  unknown: { label: 'desconocido', cls: '' },
  desconocido: { label: 'desconocido', cls: '' },
};

const DEVICE_LABELS = { desktop: 'escritorio', mobile: 'móvil', web: 'navegador' };

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 1) return '';
  const min = Math.floor(value / 60);
  if (min < 1) return `${Math.floor(value)}s`;
  if (min < 60) return `${min} min`;
  const hour = Math.floor(min / 60);
  return `${hour} h ${min % 60} min`;
}

const CDN = 'https://cdn.discordapp.com';

function defaultAvatar(userId) {
  let index = 0;
  try { index = Number((BigInt(userId) >> 22n) % 6n); } catch { index = 0; }
  return `${CDN}/embed/avatars/${index}.png`;
}

function avatarFor(userId) {
  return state.avatars?.[userId]
    || state.summary?.avatars?.[userId]
    || (userId ? defaultAvatar(userId) : '');
}

function bodyNode(text, clamp) {
  const node = el('div', 'ev__body', text);
  if (clamp && text.length > 280) node.classList.add('clamped');
  if (node.classList.contains('clamped')) {
    node.addEventListener('click', () => node.classList.toggle('clamped'), { once: false });
  }
  return node;
}

function strongAfter(prefix, name, suffix) {
  const node = el('div', 'ev__body');
  node.append(document.createTextNode(prefix));
  node.append(el('strong', null, name));
  if (suffix) node.append(document.createTextNode(suffix));
  return node;
}

function diffRow(kind, label, value) {
  const row = el('div', `diff__row diff__row--${kind}`);
  row.append(el('span', 'diff__tag', label));
  row.append(document.createTextNode(value));
  return row;
}

function pill(status) {
  const info = STATUS[status] || { label: status || '—', cls: '' };
  return el('span', `pill${info.cls ? ` pill--${info.cls}` : ''}`, info.label);
}

function profileBody(event) {
  const meta = event.metadata || {};
  const before = meta.before || null;
  const after = meta.after || null;
  const changes = meta.changes || {};
  const wrap = el('div', 'pf');

  if (meta.initial) {
    const row = el('div', 'pf__row');
    row.append(el('span', 'pf__label', 'detectado'));
    if (after?.avatar_url) {
      const img = el('img', 'pf__img pf__img--avatar');
      img.src = after.avatar_url;
      img.loading = 'lazy';
      img.alt = '';
      row.append(img);
    }
    row.append(el('span', 'pf__new', after?.display || event.username || event.user_id));
    if (after?.banner_url) {
      const img = el('img', 'pf__img pf__img--banner');
      img.src = after.banner_url;
      img.loading = 'lazy';
      img.alt = '';
      row.append(img);
    }
    wrap.append(row);
    return wrap;
  }

  const nameRow = (label, change) => {
    const row = el('div', 'pf__row');
    row.append(el('span', 'pf__label', label));
    row.append(el('span', 'pf__old', change.from ?? '—'));
    row.append(el('span', 'arrow', '→'));
    row.append(el('span', 'pf__new', change.to ?? '—'));
    return row;
  };

  const mediaRow = (label, beforeUrl, afterUrl, kind) => {
    const row = el('div', 'pf__row');
    row.append(el('span', 'pf__label', label));
    const thumb = (url) => {
      if (url) {
        const img = el('img', `pf__img pf__img--${kind}`);
        img.src = url;
        img.loading = 'lazy';
        img.alt = '';
        return img;
      }
      return el('span', 'pf__none', `sin ${label}`);
    };
    row.append(thumb(beforeUrl), el('span', 'arrow', '→'), thumb(afterUrl));
    return row;
  };

  if (changes.username) wrap.append(nameRow('nombre', changes.username));
  if (changes.global_name) wrap.append(nameRow('display', changes.global_name));
  if (meta.nick) wrap.append(nameRow('apodo', meta.nick));
  if (changes.avatar) wrap.append(mediaRow('avatar', before?.avatar_url, after?.avatar_url, 'avatar'));
  if (changes.banner) wrap.append(mediaRow('banner', before?.banner_url, after?.banner_url, 'banner'));

  return wrap.childElementCount ? wrap : null;
}

function eventBody(event) {
  const meta = event.metadata || {};

  switch (event.event_type) {
    case 'message':
      return bodyNode(event.content || '[sin texto]', true);

    case 'message_edit': {
      const wrap = el('div', 'diff');
      const before = event.old_content
        || (meta.original_known === false ? '(original no capturado)' : '(vacío)');
      wrap.append(diffRow('old', 'antes', before));
      wrap.append(diffRow('new', 'después', event.content || '(vacío)'));
      return wrap;
    }

    case 'message_delete': {
      const wrap = el('div', 'diff');
      wrap.append(diffRow('old', 'borrado', event.content || '(sin texto)'));
      return wrap;
    }

    case 'voice_join':
      return strongAfter('Entró a ', event.channel_name || event.channel_id || '—');

    case 'voice_leave': {
      const stayed = formatDuration(meta.seconds);
      return strongAfter('Salió de ', event.channel_name || event.channel_id || '—',
        stayed ? ` después de ${stayed}` : '');
    }

    case 'voice_move': {
      const node = el('div', 'ev__body');
      node.append(document.createTextNode('De '), el('strong', null, meta.from_name || meta.from || '—'),
        document.createTextNode(' a '), el('strong', null, event.channel_name || event.channel_id || '—'));
      return node;
    }

    case 'voice_stream':
      return bodyNode(meta.streaming ? 'Empezó a transmitir' : 'Dejó de transmitir');

    case 'voice_camera':
      return bodyNode(meta.camera ? 'Encendió la cámara' : 'Apagó la cámara');

    case 'profile_update':
      return profileBody(event);

    case 'presence': {
      const row = el('div', 'ev__head');
      row.style.marginTop = '8px';
      row.append(pill(meta.from), el('span', 'arrow', '→'), pill(meta.to));

      const devices = (meta.devices || []).map((d) => DEVICE_LABELS[d] || d).join(' + ');
      if (devices) row.append(el('span', 'tag', devices));
      const activities = (meta.activities || []).map((a) => a?.name).filter(Boolean).join(' · ');
      if (activities) row.append(el('span', 'tag', activities));
      return row;
    }

    default:
      return event.content ? bodyNode(event.content, true) : null;
  }
}

function card(event, isNew) {
  const meta = TYPES[event.event_type] || { icon: '•', cls: 'message', verb: event.event_type };

  const article = el('article', `ev ev--${meta.cls}`);
  article.dataset.id = String(event.id ?? '');
  if (isNew) article.classList.add('is-new');

  article.append(el('div', 'ev__icon', meta.icon));

  const main = el('div');
  const head = el('header', 'ev__head');

  const avatar = el('span', 'ev__avatar');
  const userId = String(event.user_id || '');
  avatarInto(avatar, avatarFor(userId), event.username || userId);
  avatar.style.cursor = 'pointer';
  avatar.dataset.user = userId;

  head.append(
    avatar,
    el('span', 'ev__user', event.username || userId),
    el('span', 'ev__verb', meta.verb),
  );

  const time = el('time', 'ev__time', timeAgo(event.created_at));
  time.title = new Date(event.created_at || Date.now()).toLocaleString();
  time.dataset.ts = event.created_at || '';
  head.append(time);
  main.append(head);

  const where = el('div', 'ev__where');
  if (event.channel_name) where.append(el('span', 'tag', `#${event.channel_name}`));
  if (event.guild_name) where.append(el('span', 'tag tag--click', event.guild_name));
  else if (!event.channel_name && event.channel_id) where.append(el('span', 'tag', event.channel_id));
  if (where.childElementCount) main.append(where);

  const body = eventBody(event);
  if (body) main.append(body);

  article.append(main);
  return article;
}

function matches(event) {
  if (!typeMatches(event.event_type, state.type)) return false;
  if (state.guild && String(event.guild_id || '') !== state.guild) return false;
  if (state.user && String(event.user_id || '') !== state.user) return false;
  if (state.q) {
    const needle = state.q.toLowerCase();
    const hay = `${event.username ?? ''} ${event.content ?? ''} ${event.old_content ?? ''} ${event.channel_name ?? ''}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

function renderFeed() {
  const feed = $('feed');
  const visible = state.events.filter(matches);
  feed.replaceChildren();

  if (!visible.length) {
    const empty = el('div', 'empty');
    if (!state.events.length) {
      empty.append(el('strong', null, 'Sin actividad todavía'));
      empty.append(document.createTextNode(state.bot?.connected
        ? 'El bot está escuchando: apenas tu objetivo haga algo, aparece acá.'
        : 'Conectá tu token de Discord y fijá un objetivo para empezar a ver actividad.'));
    } else {
      empty.append(el('strong', null, 'Ningún evento con estos filtros'));
      empty.append(document.createTextNode('Probá limpiar los filtros o cambiar el tipo.'));
    }
    feed.append(empty);
  } else {
    for (const event of visible) feed.append(card(event, false));
  }

  show($('more'), Boolean(state.next));
  renderFilters();
}

function renderFilters() {
  const active = Boolean(state.user || state.guild || state.q);
  show($('filters'), active);
  if (state.user) {
    const target = state.targets.find((row) => String(row.user_id) === state.user);
    $('user-filter-name').textContent = target?.username || state.user;
  }
  $('user-filter-clear').classList.toggle('hidden', !state.user);
}

function prependEvent(event) {
  if (!matches(event)) return;
  state.events.unshift(event);
  const feed = $('feed');
  const empty = feed.querySelector('.empty');
  if (empty) feed.replaceChildren();
  feed.prepend(card(event, true));
  while (feed.children.length > 300) feed.lastElementChild.remove();
}

/* ----------------------------------------------------------------- feed -- */

const PAGE = 60;

function feedQuery(offset) {
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
  if (state.type) params.set('type', state.type);
  if (state.user) params.set('user', state.user);
  if (state.guild) params.set('guild', state.guild);
  if (state.q) params.set('q', state.q);
  return `/api/events?${params}`;
}

async function loadFeed({ append = false } = {}) {
  const seq = ++state.feedSeq;
  state.feedController?.abort();
  const controller = new AbortController();
  state.feedController = controller;
  state.feedLoading = true;

  const offset = append ? state.events.length : 0;
  if (!append) feedSkeleton();

  try {
    const data = await api(feedQuery(offset), { signal: controller.signal });
    if (seq !== state.feedSeq) return;
    const rows = data.events || [];
    state.events = append ? [...state.events, ...rows] : rows;
    state.next = data.next || null;
    if (data.dbError) noteDbError(data.dbError);
    renderFeed();
  } catch (error) {
    if (error.name === 'AbortError' || seq !== state.feedSeq) return;
    state.events = append ? state.events : [];
    state.next = null;
    renderFeed();
    toast(error.message, 'bad');
  } finally {
    if (seq === state.feedSeq) {
      state.feedLoading = false;
      state.feedController = null;
    }
  }
}

function feedSkeleton() {
  const feed = $('feed');
  feed.replaceChildren();
  for (let i = 0; i < 4; i += 1) feed.append(el('div', 'skel'));
}

function noteDbError(message) {
  if (state.db) state.db = { ...state.db, ok: false, message };
  renderDb();
}

/* -------------------------------------------------------------- resumen --- */

let summaryTimer = 0;

function refreshSummary({ immediate = false } = {}) {
  clearTimeout(summaryTimer);
  const run = async () => {
    try {
      const summary = await api('/api/summary');
      state.summary = summary;
      if (summary.dbError) noteDbError(summary.dbError);
      renderStats();
      renderTargets();
    } catch {
      // silencioso: el polling reintenta y el banner ya avisa del problema
    }
  };
  if (immediate) run();
  else summaryTimer = setTimeout(run, 700);
}

function localSummaryBump(event) {
  const summary = state.summary;
  if (!summary) return;
  summary.total24h = (summary.total24h || 0) + 1;
  summary.byType = summary.byType || {};
  summary.byType[event.event_type] = (summary.byType[event.event_type] || 0) + 1;

  summary.presence = summary.presence || {};
  summary.voice = summary.voice || {};
  summary.activity = summary.activity || {};

  const meta = event.metadata || {};
  const userId = String(event.user_id || '');
  if (event.event_type === 'presence') {
    summary.presence[userId] = meta.to || null;
    summary.activity[userId] = {
      status: meta.to || null,
      activities: meta.activities || [],
      devices: meta.devices || [],
    };
  }
  if (event.event_type.startsWith('voice_')) {
    const previous = summary.voice[userId] || {};
    if (event.event_type === 'voice_join' || event.event_type === 'voice_move') {
      summary.voice[userId] = {
        ...previous,
        channel_name: event.channel_name || event.channel_id,
        since: Date.parse(event.created_at) || Date.now(),
      };
    } else if (event.event_type === 'voice_leave') {
      delete summary.voice[userId];
    } else if (event.event_type === 'voice_stream') {
      summary.voice[userId] = { ...previous, streaming: Boolean(meta.streaming) };
    } else if (event.event_type === 'voice_camera') {
      summary.voice[userId] = { ...previous, camera: Boolean(meta.camera) };
    }
  }
  if (event.event_type === 'profile_update' && meta.after?.avatar_url) {
    summary.avatars = summary.avatars || {};
    summary.avatars[userId] = meta.after.avatar_url;
  }
  renderStats();
  renderTargets();
}

/* ------------------------------------------------------------------ bot --- */

async function pollBot() {
  if (state.botBusy) return;
  state.botBusy = true;
  try {
    const data = await api('/api/settings');
    state.bot = data.bot;
    state.account = data.account || state.account;
    state.db = data.db || state.db;
    renderBot();
    renderAccount();
    renderDb();

    if (state.bot.connected && !state.wasConnected) {
      state.wasConnected = true;
      toast('Cuenta de Discord conectada');
      await reloadTargets();
      loadFeed();
    }
    if (!state.bot.connected) state.wasConnected = false;
  } catch (error) {
    if (error.status === 401) return toAuth();
  } finally {
    state.botBusy = false;
  }
}

function startBotPolling() {
  clearInterval(state.botTimer);
  const connecting = state.bot?.connecting || (state.bot?.configured && !state.bot?.connected);
  state.botTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.bot?.connected && !state.bot?.error) {
      clearInterval(state.botTimer);
      state.botTimer = 0;
      return;
    }
    pollBot();
  }, connecting ? 2000 : 6000);
}

/* --------------------------------------------------------------- targets -- */

async function reloadTargets() {
  try {
    const data = await api('/api/targets');
    state.targets = data.targets || [];
    hydrateAvatars();
    renderTargets();
    renderStats();
  } catch (error) {
    if (error.status === 401) return toAuth();
    toast(error.message, 'bad');
  }
}

function hydrateAvatars() {
  const known = new Map();
  for (const event of state.events) {
    const id = String(event.user_id || '');
    if (id && !known.has(id) && event.metadata?.after?.avatar_url) {
      known.set(id, event.metadata.after.avatar_url);
    }
  }
  for (const target of state.targets) {
    if (!target.avatar_url) target.avatar_url = known.get(String(target.user_id)) || null;
  }
}

async function addTarget(userId, note) {
  const id = String(userId);
  const existing = state.targets.find((row) => String(row.user_id) === id);
  if (existing) {
    if (existing.pending) return;
    if (note) existing.note = note;
    existing.pending = true;
    renderTargets();
  } else {
    state.targets = [
      ...state.targets,
      { user_id: id, username: null, note: note || null, pending: true, created_at: new Date().toISOString() },
    ];
    renderTargets();
  }

  try {
    const data = await api('/api/targets', { method: 'POST', body: { user_id: id, note: note || '' } });
    let placed = false;
    state.targets = state.targets.reduce((rows, row) => {
      if (String(row.user_id) !== id) rows.push(row);
      else if (!placed) {
        rows.push({ ...row, ...data.target, pending: false });
        placed = true;
      }
      return rows;
    }, []);
    renderTargets();
    toast('Objetivo fijado');
    $('target-form').reset();
    refreshSummary();
    loadFeedForUser(id);
  } catch (error) {
    if (existing) {
      existing.pending = false;
    } else {
      state.targets = state.targets.filter((row) => !(String(row.user_id) === id && row.pending));
    }
    renderTargets();
    toast(error.message, 'bad');
  }
}

async function removeTarget(userId) {
  state.targets = state.targets.map((row) => (
    String(row.user_id) === userId ? { ...row, pending: true } : row
  ));
  renderTargets();
  try {
    await api(`/api/targets/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    state.targets = state.targets.filter((row) => String(row.user_id) !== userId);
    if (state.user === userId) setUserFilter('');
    toast('Dejaste de seguir a ese usuario');
    refreshSummary();
  } catch (error) {
    state.targets = state.targets.map((row) => (
      String(row.user_id) === userId ? { ...row, pending: false } : row
    ));
    toast(error.message, 'bad');
  }
  renderTargets();
}

function loadFeedForUser(userId) {
  if (state.user && state.user !== userId) return;
  state.user = userId;
  loadFeed();
}

function setUserFilter(userId) {
  state.user = userId || '';
  renderFilters();
  loadFeed();
}

/* ------------------------------------------------------------------ SSE -- */

function openStream() {
  state.source?.close();
  const source = new EventSource('/api/stream');
  state.source = source;

  source.onopen = () => {
    setLive(true);
    if (state.streamDownSince && Date.now() - state.streamDownSince > 8000) refreshSummary({ immediate: true });
    state.streamDownSince = 0;
  };

  source.onmessage = (message) => {
    let rows;
    try {
      rows = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!Array.isArray(rows)) rows = [rows];
    for (const row of rows) {
      if (!row?.event_type) continue;
      state.events.unshift(row);
      if (state.events.length > 400) state.events.length = 400;
      prependEvent(row);
      localSummaryBump(row);
    }
  };

  source.onerror = () => {
    setLive(false);
    state.streamDownSince = state.streamDownSince || Date.now();
    // EventSource reintenta solo; si la sesión murió, el poll de bot lo detecta.
  };
}

function closeStream() {
  state.source?.close();
  state.source = null;
  setLive(false);
}

function setLive(on) {
  const dot = $('live-dot');
  dot.className = `dot ${on ? 'dot--live' : 'dot--down'}`;
  $('live-label').textContent = on ? 'en vivo' : 'reconectando';
}

/* ------------------------------------------------------------ token/acc -- */

async function saveToken(token, box) {
  box.textContent = 'Validando el token…';
  box.className = 'onb__msg';
  try {
    const data = await api('/api/settings/token', { method: 'PUT', body: { token } });
    state.account = data.account || state.account;
    state.bot = data.bot || state.bot;
    renderAccount();
    renderBot();
    startBotPolling();
    box.textContent = 'Conectado. Ya podés fijar un objetivo.';
    box.className = 'onb__msg is-ok';
    toast('Token guardado');
    setTimeout(() => {
      show($('onboarding'), false);
      loadFeed();
      reloadTargets();
    }, 900);
    return true;
  } catch (error) {
    box.textContent = error.message;
    box.className = 'onb__msg is-bad';
    return false;
  }
}

async function clearToken(box) {
  box.textContent = 'Desconectando…';
  box.className = 'cfg__msg';
  try {
    const data = await api('/api/settings/token', { method: 'DELETE' });
    state.account = data.account || state.account;
    state.bot = null;
    renderAccount();
    renderBot();
    show($('onboarding'), true);
    box.textContent = 'Token quitado de tu cuenta.';
    box.className = 'cfg__msg is-ok';
    toast('Cuenta de Discord desconectada');
  } catch (error) {
    box.textContent = error.message;
    box.className = 'cfg__msg is-bad';
  }
}

/* ---------------------------------------------------------------- picker -- */

const picker = $('picker');
const settings = $('settings');

function openModal(node) {
  if (!node.open) node.showModal();
  document.body.classList.add('is-locked');
}

function closeModal(node) {
  if (node.open) node.close();
  if (![...document.querySelectorAll('dialog')].some((d) => d.open)) {
    document.body.classList.remove('is-locked');
  }
}

function renderGuildOptions() {
  const select = $('picker-guild');
  select.replaceChildren();
  const guilds = state.guilds || [];
  if (!guilds.length) {
    select.append(el('option', null, 'Sin servidores cargados'));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  for (const guild of guilds) {
    const option = el('option', null, guild.name);
    option.value = guild.id;
    select.append(option);
  }
}

async function loadMembers(query) {
  const seq = ++state.memberSeq;
  state.memberController?.abort();
  const controller = new AbortController();
  state.memberController = controller;

  const guild = $('picker-guild').value;
  if (!guild) {
    $('picker-list').replaceChildren(el('div', 'hint', 'Elegí un servidor.'));
    return;
  }

  const list = $('picker-list');
  list.replaceChildren(el('div', 'hint', 'Buscando miembros…'));
  $('picker-error').textContent = '';

  const params = new URLSearchParams({ guild });
  if (query) params.set('q', query);

  try {
    const data = await api(`/api/members?${params}`, { signal: controller.signal });
    if (seq !== state.memberSeq) return;
    const members = data.members || [];
    list.replaceChildren();
    if (!members.length) {
      list.append(el('div', 'hint', 'No aparecieron miembros. Puede que la lista esté limitada para selfbots.'));
      return;
    }
    for (const member of members) {
      const row = el('div', 'member');
      const avatar = el('div', 'member__avatar');
      avatarInto(avatar, member.avatar_url, member.username);
      row.append(avatar, el('span', 'member__name', member.username), el('span', 'member__id', member.id));
      const tracked = state.targets.some((target) => String(target.user_id) === String(member.id));
      const button = el('button', 'btn btn--mini', tracked ? 'Siguiendo' : 'Fijar');
      button.type = 'button';
      if (tracked) button.disabled = true;
      else
        button.addEventListener('click', () => {
          closeModal(picker);
          addTarget(member.id, '');
        });
      row.append(button);
      list.append(row);
    }
  } catch (error) {
    if (error.name === 'AbortError' || seq !== state.memberSeq) return;
    list.replaceChildren();
    $('picker-error').textContent = error.message;
  }
}

/* ------------------------------------------------------------ listeners -- */

$('target-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const userId = snowflake($('target-id').value);
  if (!userId) {
    toast('El ID necesita entre 17 y 20 dígitos', 'bad');
    $('target-id').focus();
    return;
  }
  $('target-submit').disabled = true;
  addTarget(userId, $('target-note').value.trim())
    .finally(() => { $('target-submit').disabled = false; });
});

$('targets').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-remove]');
  if (remove) {
    event.stopPropagation();
    removeTarget(remove.dataset.remove);
    return;
  }
  const row = event.target.closest('[data-user]');
  if (row) setUserFilter(state.user === row.dataset.user ? '' : row.dataset.user);
});

$('targets').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('[data-user]');
  if (!row) return;
  event.preventDefault();
  setUserFilter(state.user === row.dataset.user ? '' : row.dataset.user);
});

$('chips').addEventListener('click', (event) => {
  const chip = event.target.closest('[data-type]');
  if (!chip) return;
  state.type = chip.dataset.type;
  for (const node of $('chips').children) node.classList.toggle('is-on', node === chip);
  loadFeed();
});

$('feed').addEventListener('click', (event) => {
  const avatar = event.target.closest('.ev__avatar[data-user]');
  if (avatar && avatar.dataset.user) {
    setUserFilter(state.user === avatar.dataset.user ? '' : avatar.dataset.user);
    return;
  }
  const body = event.target.closest('.ev__body.clamped');
  if (body) body.classList.toggle('clamped');
});

$('user-filter-clear').addEventListener('click', () => setUserFilter(''));
$('clear-filters').addEventListener('click', () => {
  state.user = '';
  state.guild = '';
  state.q = '';
  state.type = '';
  $('search').value = '';
  $('guild-select').value = '';
  for (const node of $('chips').children) node.classList.toggle('is-on', !node.dataset.type);
  loadFeed();
});

const runSearch = debounce(() => {
  state.q = $('search').value.trim();
  loadFeed();
}, 350);
$('search').addEventListener('input', runSearch);
$('search').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    runSearch();
  }
});

$('guild-select').addEventListener('change', () => {
  state.guild = $('guild-select').value;
  loadFeed();
});

$('more').addEventListener('click', () => loadFeed({ append: true }));
$('refresh').addEventListener('click', () => {
  loadFeed();
  refreshSummary({ immediate: true });
  pollBot();
  toast('Actualizado');
});

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  if (state.paused) {
    closeStream();
    $('pause').textContent = 'Reanudar';
    setLive(false);
    $('live-label').textContent = 'en pausa';
  } else {
    openStream();
    $('pause').textContent = 'Pausar';
  }
});

$('bot-action').addEventListener('click', () => {
  api('/api/bot/reconnect', { method: 'POST' })
    .then((data) => {
      state.bot = data.bot;
      renderBot();
      startBotPolling();
      toast('Reintentando la conexión');
    })
    .catch((error) => toast(error.message, 'bad'));
});

$('onboarding-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const token = $('onboarding-token').value.trim();
  if (!token) {
    $('onboarding-msg').textContent = 'Pegá el token primero.';
    $('onboarding-msg').className = 'onb__msg is-bad';
    return;
  }
  $('onboarding-submit').disabled = true;
  saveToken(token, $('onboarding-msg')).finally(() => { $('onboarding-submit').disabled = false; });
});

$('open-picker').addEventListener('click', () => {
  renderGuildOptions();
  openModal(picker);
  loadMembers('');
});
$('picker-guild').addEventListener('change', () => loadMembers($('picker-search').value.trim()));
$('picker-search').addEventListener('input', debounce(() => loadMembers($('picker-search').value.trim()), 320));

$('open-settings').addEventListener('click', () => openModal(settings));
$('open-settings-top').addEventListener('click', () => openModal(settings));
settings.addEventListener('click', (event) => {
  if (event.target === settings || event.target.closest('[data-close]')) closeModal(settings);
});
picker.addEventListener('click', (event) => {
  if (event.target === picker || event.target.closest('[data-close]')) closeModal(picker);
});
for (const node of document.querySelectorAll('dialog')) {
  node.addEventListener('cancel', () => {
    if (![...document.querySelectorAll('dialog')].some((d) => d.open && d !== node)) {
      document.body.classList.remove('is-locked');
    }
  });
}

$('set-token-save').addEventListener('click', () => {
  const token = $('set-token').value.trim();
  const box = $('set-token-msg');
  if (!token) {
    box.textContent = 'Pegá el token de Discord.';
    box.className = 'cfg__msg is-bad';
    return;
  }
  $('set-token-save').disabled = true;
  box.textContent = 'Validando…';
  box.className = 'cfg__msg';
  api('/api/settings/token', { method: 'PUT', body: { token } })
    .then((data) => {
      state.account = data.account || state.account;
      state.bot = data.bot || state.bot;
      renderAccount();
      renderBot();
      startBotPolling();
      show($('onboarding'), false);
      $('set-token').value = '';
      box.textContent = 'Guardado y reconectando.';
      box.className = 'cfg__msg is-ok';
      toast('Token actualizado');
      loadFeed();
    })
    .catch((error) => {
      box.textContent = error.message;
      box.className = 'cfg__msg is-bad';
    })
    .finally(() => { $('set-token-save').disabled = false; });
});

$('set-token-clear').addEventListener('click', () => clearToken($('set-token-msg')));

/* ------------------------------------------------------------ webhook ----- */

function setWebhookView(view, box, okText) {
  state.account = { ...(state.account || {}), webhook: view || { configured: false, preview: null } };
  renderAccount();
  if (box && okText) {
    box.textContent = okText;
    box.className = 'cfg__msg is-ok';
  }
}

function webhookFail(box) {
  return (error) => {
    box.textContent = error.message;
    box.className = 'cfg__msg is-bad';
  };
}

$('set-wh-save').addEventListener('click', () => {
  const box = $('set-wh-msg');
  const url = $('set-wh-url').value.trim();
  if (!url) {
    box.textContent = 'Pegá la URL del webhook de Discord.';
    box.className = 'cfg__msg is-bad';
    return;
  }
  $('set-wh-save').disabled = true;
  box.textContent = 'Guardando…';
  box.className = 'cfg__msg';
  api('/api/webhook', { method: 'PUT', body: { url } })
    .then((data) => {
      $('set-wh-url').value = '';
      setWebhookView(data.webhook, box, 'Guardado: el registro de actividad va a ese canal.');
      toast('Webhook guardado');
    })
    .catch(webhookFail(box))
    .finally(() => { $('set-wh-save').disabled = false; });
});

$('set-wh-test').addEventListener('click', () => {
  const box = $('set-wh-msg');
  const url = $('set-wh-url').value.trim();
  $('set-wh-test').disabled = true;
  box.textContent = 'Enviando la prueba…';
  box.className = 'cfg__msg';
  api('/api/webhook/test', { method: 'POST', body: url ? { url } : {} })
    .then((data) => {
      box.textContent = `Probado: ${data.sent}`;
      box.className = 'cfg__msg is-ok';
      toast('Mensaje de prueba enviado');
    })
    .catch(webhookFail(box))
    .finally(() => { $('set-wh-test').disabled = false; });
});

$('set-wh-clear').addEventListener('click', () => {
  const box = $('set-wh-msg');
  $('set-wh-clear').disabled = true;
  box.textContent = 'Quitando…';
  box.className = 'cfg__msg';
  api('/api/webhook', { method: 'DELETE', body: {} })
    .then((data) => {
      $('set-wh-url').value = '';
      setWebhookView(data.webhook, box, 'Webhook quitado: no se manda nada al canal.');
    })
    .catch(webhookFail(box))
    .finally(() => { $('set-wh-clear').disabled = false; });
});

$('set-password-save').addEventListener('click', () => {
  const box = $('set-password-msg');
  box.textContent = 'Guardando…';
  box.className = 'cfg__msg';
  api('/api/account', {
    method: 'PUT',
    body: { current: $('set-current').value, password: $('set-password').value },
  })
    .then((data) => {
      state.account = data.account || state.account;
      renderAccount();
      $('set-current').value = '';
      $('set-password').value = '';
      box.textContent = 'Contraseña actualizada.';
      box.className = 'cfg__msg is-ok';
      toast('Contraseña cambiada');
    })
    .catch((error) => {
      box.textContent = error.message;
      box.className = 'cfg__msg is-bad';
    });
});

$('set-hwid-clear').addEventListener('click', () => {
  const box = $('set-hwid-msg');
  box.textContent = 'Desvinculando…';
  box.className = 'cfg__msg';
  api('/api/account/hwid', { method: 'DELETE', body: { password: $('set-hwid-password').value } })
    .then(() => {
      box.textContent = 'Listo. Iniciá sesión en el equipo nuevo.';
      box.className = 'cfg__msg is-ok';
      setTimeout(toAuth, 900);
    })
    .catch((error) => {
      box.textContent = error.message;
      box.className = 'cfg__msg is-bad';
    });
});

/* ---------------------------------------------------------------- admin -- */

const admin = $('admin');

function stamp(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const date = new Date(then);
  return `${date.toLocaleDateString()} ${clockTime(iso)}`;
}

function browserName(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return '';
  const brands = [['Edg', 'Edge'], ['OPR', 'Opera'], ['Firefox', 'Firefox'], ['Chrome', 'Chrome'], ['Safari', 'Safari']];
  const systems = [['Windows NT', 'Windows'], ['Android', 'Android'], ['iPhone', 'iOS'], ['iPad', 'iPadOS'], ['Mac OS X', 'macOS'], ['Linux', 'Linux']];
  const brand = brands.find(([token]) => ua.includes(`${token}/`));
  const system = systems.find(([token]) => ua.includes(token));
  const version = brand ? (ua.match(new RegExp(`${brand[0]}/(\\d+)`)) || [])[1] : null;
  return [brand ? `${brand[1]} ${version || ''}`.trim() : 'navegador', system && system[1]].filter(Boolean).join(' · ');
}

function sumItem(value, label) {
  const item = el('div', 'asum');
  item.append(el('div', 'asum__v', String(value ?? 0)));
  item.append(el('div', 'asum__l', label));
  return item;
}

function acctField(label, value, cls) {
  const wrap = el('div', `acct__f${cls ? ` ${cls}` : ''}`);
  wrap.append(el('span', 'acct__k', label));
  wrap.append(el('span', 'acct__v', value || '—'));
  return wrap;
}

function adminRun(button, run) {
  button.disabled = true;
  Promise.resolve()
    .then(run)
    .catch((error) => {
      if (error.name !== 'AbortError') toast(error.message, 'bad');
      button.disabled = false;
    });
}

function accountCard(row) {
  const card = el('div', 'acct');
  if (row.status === 'blocked') card.classList.add('is-blocked');
  if (row.self) card.classList.add('is-self');

  const head = el('div', 'acct__head');
  head.append(el('div', 'acct__name', row.username));
  const chips = el('div', 'acct__chips');
  if (row.role === 'admin') chips.append(el('span', 'atag atag--admin', 'admin'));
  if (row.self) chips.append(el('span', 'atag', 'vos'));
  if (row.legacy) chips.append(el('span', 'atag', 'deploy'));
  if (row.status === 'blocked') chips.append(el('span', 'atag atag--bad', 'bloqueada'));
  if (row.hasToken) chips.append(el('span', 'atag atag--ok', 'token'));
  head.append(chips);
  card.append(head);

  const discord = row.discord || {};
  const grid = el('div', 'acct__grid');
  grid.append(acctField('discord', discord.linked ? [discord.username, discord.user_id].filter(Boolean).join(' · ') : 'sin token'));
  grid.append(acctField('token', discord.token_preview, 'acct__f--mono'));
  grid.append(acctField('último ingreso', row.last_login_at ? `${stamp(row.last_login_at)} · ${timeAgo(row.last_login_at)}` : ''));
  grid.append(acctField('actividad', row.last_seen_at ? timeAgo(row.last_seen_at) : ''));
  grid.append(acctField('ip', row.last_ip, 'acct__f--mono'));
  grid.append(acctField('navegador', browserName(row.user_agent)));
  grid.append(acctField('dispositivo', row.hwid_linked ? (row.hwid_label || 'vinculado') : 'sin vincular'));
  grid.append(acctField('usado', `${row.events_7d || 0} ev. 7d · ${row.targets || 0} obj.`));
  grid.append(acctField('sesiones', `${row.login_count || 0} ingresos · ${row.boot_count || 0} aperturas`));
  grid.append(acctField('último evento', row.last_event_at ? timeAgo(row.last_event_at) : ''));
  grid.append(acctField('creada', stamp(row.created_at)));
  if (row.block_reason) grid.append(acctField('motivo del bloqueo', row.block_reason));
  card.append(grid);

  const actions = el('div', 'acct__actions');
  const forms = el('div', 'acct__forms');
  const canHistory = Boolean(state.admin?.db?.configured);

  const toggle = (id, label, variant) => {
    const button = el('button', `btn btn--mini ${variant || 'btn--ghost'}`, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      const box = forms.querySelector(`[data-form="${id}"]`);
      const open = !box.classList.toggle('hidden');
      for (const other of forms.children) if (other !== box) other.classList.add('hidden');
      if (open) box.querySelector('input')?.focus();
    });
    actions.append(button);
    return button;
  };

  const formBox = (id) => {
    const box = el('div', 'acct__form hidden');
    box.dataset.form = id;
    forms.append(box);
    return box;
  };

  const reload = () => loadAdmin();

  if (canHistory) {
    const button = el('button', 'btn btn--ghost btn--mini', 'Historial');
    button.type = 'button';
    button.addEventListener('click', () => openHistory(row.username));
    actions.append(button);
  }

  if (row.legacy) {
    actions.append(el('span', 'acct__note', 'Cuenta del deploy: la contraseña se cambia en las variables.'));
  } else if (!row.self) {
    // Bloqueo: con motivo, para que la persona lo vea al intentar entrar.
    const box = formBox('block');
    const input = el('input', 'small');
    input.type = 'text';
    input.placeholder = 'motivo (opcional)';
    input.autocomplete = 'off';
    const ok = el('button', 'btn btn--mini', 'Bloquear');
    ok.type = 'button';
    ok.addEventListener('click', () => adminRun(ok, async () => {
      await api(`/api/admin/accounts/${encodeURIComponent(row.username)}/status`, {
        method: 'POST', body: { status: 'blocked', reason: input.value.trim() },
      });
      toast(`${row.username} bloqueada`);
      await reload();
    }));
    box.append(input, ok);

    toggle('block', row.status === 'blocked' ? 'Cambiar motivo' : 'Bloquear', 'btn--danger');
  }

  if (row.status === 'blocked') {
    const button = el('button', 'btn btn--ghost btn--mini', 'Desbloquear');
    button.type = 'button';
    button.addEventListener('click', () => adminRun(button, async () => {
      await api(`/api/admin/accounts/${encodeURIComponent(row.username)}/status`, {
        method: 'POST', body: { status: 'active' },
      });
      toast(`${row.username} activada`);
      await reload();
    }));
    actions.append(button);
  }

  if (!row.legacy) {
    // El hash scrypt no se lee: el admin fija una contraseña nueva.
    const box = formBox('password');
    const input = el('input', 'small');
    input.type = 'password';
    input.placeholder = 'contraseña nueva (mín. 8)';
    input.autocomplete = 'new-password';
    const ok = el('button', 'btn btn--mini', 'Fijar');
    ok.type = 'button';
    ok.addEventListener('click', () => {
      const value = input.value;
      if (value.length < 8) { toast('La contraseña necesita 8 caracteres o más', 'bad'); return; }
      adminRun(ok, async () => {
        await api(`/api/admin/accounts/${encodeURIComponent(row.username)}/password`, {
          method: 'POST', body: { password: value },
        });
        toast(`Contraseña de ${row.username} cambiada`);
        await reload();
      });
    });
    box.append(input, ok);
    toggle('password', 'Contraseña');
  }

  if (row.hwid_linked) {
    const button = el('button', 'btn btn--ghost btn--mini', 'Desvincular equipo');
    button.type = 'button';
    button.addEventListener('click', () => adminRun(button, async () => {
      await api(`/api/admin/accounts/${encodeURIComponent(row.username)}/unlink`, { method: 'POST' });
      toast(`${row.username} sin dispositivo`);
      await reload();
    }));
    actions.append(button);
  }

  if (!row.self && !row.legacy) {
    const button = el('button', 'btn btn--ghost btn--mini', row.role === 'admin' ? 'Quitar admin' : 'Hacer admin');
    button.type = 'button';
    button.addEventListener('click', () => adminRun(button, async () => {
      await api(`/api/admin/accounts/${encodeURIComponent(row.username)}/role`, {
        method: 'POST', body: { role: row.role === 'admin' ? 'user' : 'admin' },
      });
      toast('Rol actualizado');
      await reload();
    }));
    actions.append(button);
  }

  if (!row.self && !row.legacy) {
    const button = el('button', 'btn btn--danger btn--mini', 'Borrar');
    button.type = 'button';
    let armed = 0;
    button.addEventListener('click', () => {
      if (!armed) {
        armed = Date.now();
        button.textContent = 'Confirmar borrado';
        setTimeout(() => {
          if (!button.disabled && Date.now() - armed >= 4000) { armed = 0; button.textContent = 'Borrar'; }
        }, 4200);
        return;
      }
      armed = 0;
      button.textContent = 'Borrando…';
      adminRun(button, async () => {
        await api(`/api/admin/accounts/${encodeURIComponent(row.username)}`, { method: 'DELETE' });
        toast(`${row.username} borrada con sus datos`);
        await reload();
      });
    });
    actions.append(button);
  }

  card.append(actions, forms);
  return card;
}

function renderAdmin() {
  const data = state.admin;
  const list = $('admin-list');
  if (!data) return;

  const totals = data.totals || {};
  $('admin-summary').replaceChildren(
    sumItem(totals.accounts, 'cuentas'),
    sumItem(totals.admins, 'admins'),
    sumItem(totals.blocked, 'bloqueadas'),
    sumItem(totals.withToken, 'con token'),
  );

  const hints = [];
  if (data.approximate) hints.push('El uso es aproximado: la función admin_usage no está en la base. Volvé a correr schema.sql.');
  if (data.db && !data.db.configured) hints.push('Sin base de datos: sólo se ven las cuentas del archivo local.');
  const note = $('admin-note');
  note.textContent = hints.join(' ');
  show(note, hints.length > 0);

  const rows = data.accounts || [];
  if (!rows.length) {
    list.replaceChildren(el('div', 'hint', 'No hay cuentas dadas de alta todavía.'));
    return;
  }
  list.replaceChildren(...rows.map(accountCard));
}

async function loadAdmin() {
  const seq = ++state.adminSeq;
  $('admin-error').textContent = '';
  $('admin-list').replaceChildren(el('div', 'hint', 'Cargando cuentas…'));
  try {
    const data = await api('/api/admin/accounts');
    if (seq !== state.adminSeq) return;
    state.admin = data;
    renderAdmin();
  } catch (error) {
    if (seq !== state.adminSeq) return;
    $('admin-list').replaceChildren();
    $('admin-error').textContent = error.message;
    if (error.status === 401) { closeModal(admin); toAuth(); }
    if (error.status === 403) closeModal(admin);
  }
}

$('open-admin').addEventListener('click', () => {
  openModal(admin);
  loadAdmin();
});
$('admin-refresh').addEventListener('click', () => loadAdmin());
admin.addEventListener('click', (event) => {
  if (event.target === admin || event.target.closest('[data-close]')) closeModal(admin);
});

/* -------------------------------------------------------------- historial -- */

const history = $('history');

const HISTORY_CHUNK = 500;
const RANGE_DAYS = { '1d': 1, '7d': 7, '30d': 30 };

function blankHistory(user) {
  return {
    user,
    rows: [],
    total: 0,
    hasMore: false,
    checked: new Set(),
    seq: 0,
    controller: null,
    busy: false,
  };
}

function readHistoryFilters() {
  return {
    type: $('history-type').value,
    range: $('history-range').value,
    q: $('history-q').value.trim(),
  };
}

function historyActive(filters) {
  return Boolean(filters.type || filters.range || filters.q);
}

/** `from` va en ISO: el server lo valida con Date.parse y lo recorta. */
function historyFrom(range) {
  const days = RANGE_DAYS[range];
  return days ? new Date(Date.now() - days * 864e5).toISOString() : '';
}

function historyText(event) {
  const meta = event.metadata || {};
  const clip = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const stayed = formatDuration(meta.seconds);

  switch (event.event_type) {
    case 'message':
      return clip(event.content) || '[sin texto]';
    case 'message_edit':
      return `${clip(event.old_content) || '(sin original)'} → ${clip(event.content) || '(vacío)'}`;
    case 'message_delete':
      return clip(event.content) || '(sin texto)';
    case 'voice_join':
      return `entró a ${clip(event.channel_name || event.channel_id) || 'un canal'}`;
    case 'voice_leave':
      return `salió de ${clip(event.channel_name || event.channel_id) || 'un canal'}${stayed ? ` · estuvo ${stayed}` : ''}`;
    case 'voice_move':
      return `${clip(meta.from_name || meta.from) || '—'} → ${clip(event.channel_name || event.channel_id) || '—'}`;
    case 'voice_stream':
      return meta.streaming ? 'empezó a transmitir' : 'dejó de transmitir';
    case 'voice_camera':
      return meta.camera ? 'encendió la cámara' : 'apagó la cámara';
    case 'presence':
      return `${clip(meta.from) || '—'} → ${clip(meta.to) || '—'}`;
    default:
      return clip(event.content) || clip(meta.to) || event.event_type;
  }
}

function historyRow(event) {
  const st = state.history;
  const id = event.id === undefined || event.id === null ? '' : String(event.id);

  const row = el('div', 'hrow');
  row.dataset.id = id;

  const box = el('input', 'hrow__check');
  box.type = 'checkbox';
  box.value = id;
  box.disabled = !id;
  box.checked = st.checked.has(id);
  box.setAttribute('aria-label', 'seleccionar evento');
  row.append(box);

  const meta = TYPES[event.event_type] || { icon: '•', cls: 'message', verb: event.event_type };
  row.append(el('span', `hrow__icon hrow__icon--${meta.cls}`, meta.icon));

  const main = el('div', 'hrow__main');
  const head = el('div', 'hrow__head');
  head.append(el('span', 'hrow__user', event.username || String(event.user_id || '—')));
  head.append(el('span', 'hrow__verb', meta.verb));
  const time = el('time', 'hrow__time', stamp(event.created_at) || '—');
  time.title = timeAgo(event.created_at) || '';
  head.append(time);
  main.append(head);

  main.append(el('div', 'hrow__text', historyText(event)));

  const tags = el('div', 'hrow__tags');
  if (event.channel_name) tags.append(el('span', 'tag', `#${event.channel_name}`));
  if (event.guild_name) tags.append(el('span', 'tag', event.guild_name));
  if (tags.childElementCount) main.append(tags);

  row.append(main);
  return row;
}

function historyMeta() {
  const st = state.history;
  if (!st) return;
  const filters = readHistoryFilters();
  const filtered = historyActive(filters);

  const bits = [];
  bits.push(st.total ? `${st.total} evento${st.total === 1 ? '' : 's'}${filtered ? ' con el filtro' : ' en el historial'}` : 'Sin eventos');
  if (filtered && st.total > st.rows.length) bits.push(`${st.rows.length} cargados`);
  if (st.checked.size) bits.push(`${st.checked.size} seleccionados`);
  $('history-count').textContent = bits.join(' · ');

  const boxes = [...$('history-list').querySelectorAll('input[type=checkbox]:not(:disabled)')];
  const all = boxes.filter((box) => box.checked).length;
  const checkAll = $('history-check-all');
  checkAll.checked = boxes.length > 0 && all === boxes.length;
  checkAll.indeterminate = all > 0 && all < boxes.length;
  checkAll.disabled = boxes.length === 0;

  const delSel = $('history-del-sel');
  if (delSel.dataset.armed !== '1') {
    delSel.textContent = st.checked.size ? `Borrar selección (${st.checked.size})` : 'Borrar selección';
  }
  delSel.disabled = st.busy || st.checked.size === 0;

  const delFilt = $('history-del-filt');
  show(delFilt, filtered && st.total > 0);
  delFilt.disabled = st.busy;
  if (delFilt.dataset.armed !== '1') {
    delFilt.textContent = filtered && st.total ? `Borrar los ${st.total} del filtro` : 'Borrar por filtro';
  }

  const delAll = $('history-del-all');
  delAll.disabled = st.busy;

  const more = $('history-more');
  show(more, st.hasMore);
  more.disabled = st.busy;
}

function renderHistory() {
  const st = state.history;
  if (!st) return;
  const list = $('history-list');
  if (!st.rows.length) {
    list.replaceChildren(el('div', 'hint', historyActive(readHistoryFilters())
      ? 'Ningún evento coincide con el filtro.'
      : 'El historial de esta cuenta está vacío.'));
  } else {
    list.replaceChildren(...st.rows.map(historyRow));
  }
  historyMeta();
}

async function loadHistory({ append = false } = {}) {
  const st = state.history;
  if (!st) return;
  if (st.controller) st.controller.abort();

  const controller = new AbortController();
  st.controller = controller;
  const seq = ++st.seq;
  st.busy = true;
  $('history-error').textContent = '';
  if (!append) $('history-list').replaceChildren(el('div', 'hint', 'Cargando historial…'));
  historyMeta();

  const params = new URLSearchParams();
  const filters = readHistoryFilters();
  if (filters.type) params.set('type', filters.type);
  if (filters.q) params.set('q', filters.q);
  const from = historyFrom(filters.range);
  if (from) params.set('from', from);
  params.set('offset', String(append ? st.rows.length : 0));

  try {
    const data = await api(`/api/admin/accounts/${encodeURIComponent(st.user)}/history?${params}`, {
      signal: controller.signal,
    });
    if (seq !== st.seq) return;
    const rows = data.events || [];
    st.rows = append ? st.rows.concat(rows) : rows;
    st.total = Number(data.total) || 0;
    st.hasMore = Boolean(data.hasMore);
    if (!append) st.checked.clear();
  } catch (error) {
    if (error.name === 'AbortError' || seq !== st.seq) return;
    $('history-error').textContent = error.message;
    if (error.status === 401) { closeHistory(); toAuth(); return; }
    if (error.status === 403) { closeHistory(); return; }
    if (error.status === 404) { closeHistory(); toast(error.message, 'bad'); return; }
    if (!append) $('history-list').replaceChildren(el('div', 'hint', 'No se pudo leer el historial.'));
  }

  st.busy = false;
  if (seq === st.seq) renderHistory();
}

/** Botón que exige un segundo clic antes de actuar. */
function armHistory(button, ask, run) {
  if (button.dataset.armed !== '1') {
    button.dataset.armed = '1';
    button.textContent = ask;
    setTimeout(() => {
      if (button.dataset.armed !== '1') return;
      button.dataset.armed = '0';
      button.textContent = button.dataset.label || ask;
      historyMeta();
    }, 4200);
    return;
  }
  button.dataset.armed = '0';
  button.textContent = button.dataset.label || ask;
  adminRun(button, run);
}

async function deleteHistory(scope, body, done) {
  const st = state.history;
  if (!st || st.busy) return;

  const ids = scope === 'ids' ? [...st.checked] : [];
  if (scope === 'ids' && !ids.length) return;

  st.busy = true;
  historyMeta();

  let removed = 0;
  try {
    if (scope === 'ids') {
      for (let i = 0; i < ids.length; i += HISTORY_CHUNK) {
        const out = await api(`/api/admin/accounts/${encodeURIComponent(st.user)}/history`, {
          method: 'DELETE',
          body: { scope: 'ids', ids: ids.slice(i, i + HISTORY_CHUNK) },
        });
        removed += Number(out.removed) || 0;
      }
      for (const id of ids) st.checked.delete(id);
    } else {
      const out = await api(`/api/admin/accounts/${encodeURIComponent(st.user)}/history`, {
        method: 'DELETE',
        body: { scope, ...body },
      });
      removed = Number(out.removed) || 0;
      if (scope === 'all') st.checked.clear();
    }
    toast(done(removed));
  } catch (error) {
    st.busy = false;
    historyMeta();
    $('history-error').textContent = error.message;
    if (error.status === 401) { closeHistory(); toAuth(); return; }
    toast(error.message, 'bad');
    return;
  }

  st.busy = false;
  const own = String(state.account?.username || '').toLowerCase() === st.user.toLowerCase();
  await Promise.all([loadHistory(), loadAdmin()]);
  if (own) await loadFeed();
  refreshSummary({ immediate: true });
}

function openHistory(username) {
  if (!state.admin?.db?.configured) {
    toast('Sin base de datos no hay historial que revisar', 'bad');
    return;
  }
  state.history = blankHistory(username);
  $('history-user').textContent = username;
  $('history-error').textContent = '';
  $('history-type').value = '';
  $('history-range').value = '';
  $('history-q').value = '';
  for (const button of [$('history-del-sel'), $('history-del-filt'), $('history-del-all')]) {
    button.dataset.armed = '0';
    button.textContent = button.dataset.label;
  }
  openModal(history);
  loadHistory();
}

function closeHistory() {
  const st = state.history;
  if (st?.controller) st.controller.abort();
  if (st) st.seq += 1;
  state.history = null;
  closeModal(history);
}

$('history-refresh').addEventListener('click', () => loadHistory());
$('history-apply').addEventListener('click', () => loadHistory());
$('history-q').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadHistory();
});
$('history-more').addEventListener('click', () => loadHistory({ append: true }));

$('history-list').addEventListener('change', (event) => {
  const st = state.history;
  const box = event.target;
  if (!st || !(box instanceof HTMLInputElement) || box.type !== 'checkbox' || !box.value) return;
  if (box.checked) st.checked.add(box.value);
  else st.checked.delete(box.value);
  historyMeta();
});

$('history-check-all').addEventListener('change', (event) => {
  const st = state.history;
  if (!st) return;
  const on = event.target.checked;
  for (const box of $('history-list').querySelectorAll('input[type=checkbox]:not(:disabled)')) {
    box.checked = on;
    if (on) st.checked.add(box.value);
    else st.checked.delete(box.value);
  }
  historyMeta();
});

$('history-del-sel').dataset.label = 'Borrar selección';
$('history-del-filt').dataset.label = 'Borrar por filtro';
$('history-del-all').dataset.label = 'Borrar todo';

$('history-del-sel').addEventListener('click', () => {
  armHistory($('history-del-sel'), `Confirmar ${state.history?.checked.size || 0}`, () =>
    deleteHistory('ids', null, (n) => `${n} evento${n === 1 ? '' : 's'} borrados de la selección`));
});

$('history-del-filt').addEventListener('click', () => {
  const filters = readHistoryFilters();
  armHistory($('history-del-filt'), 'Confirmar borrado', () =>
    deleteHistory('query', {
      type: filters.type,
      q: filters.q,
      from: historyFrom(filters.range),
    }, (n) => `${n} evento${n === 1 ? '' : 's'} borrados con ese filtro`));
});

$('history-del-all').addEventListener('click', () => {
  armHistory($('history-del-all'), '¿Borrar TODO su historial?', () =>
    deleteHistory('all', null, (n) => `${n} evento${n === 1 ? '' : 's'} borrados de ${state.history?.user || ''}`));
});

history.addEventListener('click', (event) => {
  if (event.target === history || event.target.closest('[data-close]')) closeHistory();
});
history.addEventListener('cancel', () => closeHistory());
admin.addEventListener('cancel', () => closeModal(admin));

/* --------------------------------------------------------------- sidebar -- */

function openSidebar(on) {
  $('app').classList.toggle('is-open', on);
  document.body.classList.toggle('is-locked', on && window.innerWidth <= 860);
}

$('open-sidebar').addEventListener('click', () => openSidebar(true));
$('close-sidebar').addEventListener('click', () => openSidebar(false));
$('scrim').addEventListener('click', () => openSidebar(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') openSidebar(false);
});

/* ---------------------------------------------------------------- logout -- */

async function logout() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    // la cookie ya no sirve: igual volvemos al login
  }
  toAuth();
}

$('logout').addEventListener('click', logout);

function toAuth() {
  closeStream();
  clearInterval(state.botTimer);
  state.botTimer = 0;
  state.account = null;
  state.admin = null;
  state.adminSeq += 1;
  show($('open-admin'), false);
  closeModal(admin);
  closeHistory();
  show($('app'), false);
  show($('auth'), true);
  show($('boot'), false);
  setAuthMode('login');
  openSidebar(false);
}

/* ------------------------------------------------------------------ boot -- */

function startApp(account) {
  state.account = account;
  show($('boot'), false);
  show($('auth'), false);
  show($('app'), true);
  renderAccount();
  openStream();
  startBotPolling();
}

async function loadData() {
  show($('boot'), true);
  try {
    const data = await api('/api/bootstrap');
    state.account = data.account;
    state.bot = data.bot;
    state.db = data.db;
    state.targets = data.targets || [];
    state.summary = data.summary;
    state.events = data.events || [];
    state.next = data.next || null;
    state.guilds = data.guilds || [];
    state.wasConnected = Boolean(data.bot?.connected);

    startApp(data.account);
    hydrateAvatars();
    renderBot();
    renderDb();
    renderStats();
    renderTargets();
    renderGuildSelect();
    renderFeed();
  } catch (error) {
    show($('boot'), false);
    if (error.status === 401) {
      show($('auth'), true);
      setAuthMode('login');
      return;
    }
    show($('auth'), true);
    setAuthMode(state.authMode);
    setAuthError(error.message, 'Recargá cuando el servidor vuelva a responder.');
  }
}

async function enterApp(account) {
  startApp(account);
  await loadData();
}

function renderGuildSelect() {
  const select = $('guild-select');
  const current = select.value;
  select.replaceChildren(el('option', null, 'Todos los servidores'));
  select.firstElementChild.value = '';
  for (const guild of state.guilds || []) {
    const option = el('option', null, guild.name);
    option.value = guild.id;
    select.append(option);
  }
  select.value = current;
  show(select, (state.guilds || []).length > 0);
}

/* reloj relativo del feed, una vez por minuto */
setInterval(() => {
  if (document.hidden) return;
  for (const node of document.querySelectorAll('.ev__time[data-ts]')) {
    node.textContent = timeAgo(node.dataset.ts);
  }
}, 60_000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.account && !state.source) openStream();
});

setAuthMode('login');
loadData();

