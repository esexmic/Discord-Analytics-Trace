'use strict';

/**
 * Smoke test sin credenciales reales: reemplaza Supabase por un store en
 * memoria y el gateway de Discord por objetos falsos, y ejercita el pipeline
 * completo (handlers -> cola -> "DB" -> API HTTP) sobre el modelo multi-cuenta:
 * cada evento y cada objetivo pertenece a un `owner`.
 *
 *   npm test
 */

const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `XYB-smoke-${process.pid}`);
process.env.DISCORD_TOKEN = 'fake.token.value.fake.token.value.fake';
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'fake-service-key';
process.env.DASHBOARD_USERNAME = 'tester';
process.env.DASHBOARD_PASSWORD = 'test-password';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.TRACK_ALL = 'true';
process.env.PORT = '0';

const assert = require('assert');
const { once } = require('events');
const { createFakeSupabase } = require('./fake-supabase');

const db = require('../src/db');
const store = new Map();
store.set('events', []);
store.set('targets', []);
store.set('accounts', []);

let nextId = 1;
db.__setClient(createFakeSupabase(store));
db.insertEvents = async (rows) => {
  const stored = rows.map((row) => ({ ...row, id: nextId++ }));
  store.get('events').push(...stored);
  return stored;
};

const bot = require('../src/bot');
const queue = require('../src/queue');
const targets = require('../src/targets');
const accounts = require('../src/accounts');
const { startServer } = require('../src/server');

const OWNER = 'tester';
const OTHER = 'vecina';
const TARGET_ID = '111111111111111111';
const GUILD_ID = '222222222222222222';
const CHANNEL_ID = '333333333333333333';
const SELF_ID = '999999999999999999';

const targetUser = { id: TARGET_ID, username: 'target', globalName: 'Target', discriminator: '0' };
const channel = { id: CHANNEL_ID, name: 'general' };

const guild = {
  id: GUILD_ID,
  name: 'Server Test',
  channels: { cache: new Map([[CHANNEL_ID, channel]]) },
  members: { cache: new Map([[TARGET_ID, { id: TARGET_ID, user: targetUser, displayName: 'Target' }]]) },
  presences: { cache: new Map() },
  voiceStates: { cache: new Map() },
};

const fakeClient = {
  user: { id: SELF_ID, username: 'watcher' },
  isReady: () => true,
  guilds: { cache: new Map([[GUILD_ID, guild]]) },
  users: {
    cache: new Map([[TARGET_ID, targetUser]]),
    fetch: async (id) => (String(id) === TARGET_ID
      ? targetUser
      : { id: String(id), username: 'nuevo', global_name: null, discriminator: '0' }),
  },
};

/** Runtime del owner con el client falso puesto. */
function rt(owner = OWNER) {
  bot.__setClient(owner, fakeClient);
  return bot.__runtime(owner);
}

function eventsOf(type, owner = OWNER) {
  return store.get('events').filter(
    (event) => event.event_type === type && String(event.owner) === String(owner)
  );
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ------------------------------------------------------------- handlers --- */

test('presence: conexión con actividad y dispositivos', async () => {
  const runtime = rt();
  await runtime.handlePresence({
    user: { id: TARGET_ID },
    guild_id: GUILD_ID,
    status: 'online',
    activities: [{ type: 2, name: 'Spotify', details: 'Some song' }],
    client_status: { desktop: 'online', mobile: 'online' },
  });
  await queue.drain(2000);

  const presence = eventsOf('presence').at(-1);
  assert.ok(presence, 'la primera transición se loguea');
  assert.strictEqual(presence.metadata.to, 'online');
  assert.ok(presence.metadata.devices.includes('mobile'));
  assert.strictEqual(presence.owner, OWNER, 'el evento queda en la cuenta del owner');

  const before = store.get('events').length;
  await runtime.handlePresence({
    user: { id: TARGET_ID },
    guild_id: GUILD_ID,
    status: 'online',
    activities: [],
    client_status: { desktop: 'online' },
  });
  assert.strictEqual(store.get('events').length, before, 'no debe duplicar la misma transición');
});

test('message + edit + delete', async () => {
  const runtime = rt();

  await runtime.handleMessage({
    id: 'm1',
    guild,
    channel,
    author: targetUser,
    content: 'hola',
    attachments: new Map(),
    embeds: [],
    mentions: { users: new Map() },
    reference: null,
    system: false,
  });
  await queue.drain(2000);

  await runtime.handleMessageUpdate(null, {
    id: 'm1',
    guild,
    channel,
    author: targetUser,
    content: 'hola editado',
    attachments: new Map(),
  });
  await queue.drain(2000);

  const edited = eventsOf('message_edit').at(-1);
  assert.ok(edited, 'tiene que existir el evento de edición');
  assert.strictEqual(edited.old_content, 'hola', 'el original sale de la cache del runtime');
  assert.strictEqual(edited.content, 'hola editado');
  assert.strictEqual(edited.channel_id, CHANNEL_ID);
  assert.strictEqual(edited.guild_id, GUILD_ID);
  assert.strictEqual(edited.owner, OWNER);

  await runtime.handleMessageDelete({ id: 'm1', guild, channel, author: targetUser });
  await queue.drain(2000);

  const deleted = eventsOf('message_delete').at(-1);
  assert.ok(deleted, 'tiene que existir el evento de borrado');
  assert.strictEqual(deleted.content, 'hola editado');
});

test('voice: join, stream y leave con duración', async () => {
  const runtime = rt();

  await runtime.handleVoice({
    guild_id: GUILD_ID,
    user_id: TARGET_ID,
    channel_id: CHANNEL_ID,
    self_stream: false,
    self_video: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await runtime.handleVoice({
    guild_id: GUILD_ID,
    user_id: TARGET_ID,
    channel_id: CHANNEL_ID,
    self_stream: true,
    self_video: false,
  });
  await runtime.handleVoice({
    guild_id: GUILD_ID,
    user_id: TARGET_ID,
    channel_id: null,
    self_stream: false,
    self_video: false,
  });
  await queue.drain(2000);

  assert.ok(eventsOf('voice_join').length, 'join registrado');
  assert.ok(eventsOf('voice_stream').length, 'stream registrado');
  const leave = eventsOf('voice_leave').at(-1);
  assert.ok(leave, 'leave registrado');
  assert.ok(leave.metadata.seconds >= 1, 'la duración se calcula con el join');
});

test('profile: nombre, avatar animado, banner y apodo', async () => {
  const runtime = rt();
  runtime.rememberProfile({
    id: TARGET_ID,
    username: 'target',
    global_name: 'Target',
    avatar: 'abcdef',
    banner: null,
  });

  await runtime.handleUserUpdate({
    id: TARGET_ID,
    username: 'target_renamed',
    global_name: 'Target Nuevo',
    discriminator: '0',
    avatar: 'a_abcdef',
    banner: 'banner_hash',
  });
  await queue.drain(2000);

  const profile = eventsOf('profile_update').at(-1);
  assert.ok(profile, 'tiene que existir el evento de perfil');
  assert.strictEqual(profile.metadata.changes.username.to, 'target_renamed');
  assert.strictEqual(profile.metadata.changes.global_name.to, 'Target Nuevo');
  assert.ok(profile.metadata.after.avatar_url.includes('/avatars/'));
  assert.ok(profile.metadata.after.avatar_url.includes('.gif'), 'el avatar animado usa gif');
  assert.ok(profile.metadata.after.banner_url.includes('/banners/'));

  // El primer avistamiento del member solo fija la línea de base del apodo.
  await runtime.handleMemberUpdate({
    guild_id: GUILD_ID,
    user: { id: TARGET_ID, username: 'target_renamed', global_name: 'Target Nuevo', avatar: 'a_abcdef', banner: 'banner_hash' },
    nick: null,
  });
  await runtime.handleMemberUpdate({
    guild_id: GUILD_ID,
    user: {
      id: TARGET_ID,
      username: 'target_renamed',
      global_name: 'Target Nuevo',
      avatar: 'a_abcdef',
      banner: 'banner_hash',
    },
    nick: 'apodo nuevo',
  });
  await queue.drain(2000);

  const nick = eventsOf('profile_update').at(-1);
  assert.strictEqual(nick.metadata.nick.to, 'apodo nuevo');
  assert.strictEqual(nick.guild_id, GUILD_ID);

  await runtime.handleUserUpdate({
    id: '444444444444444444',
    username: 'nuevo',
    global_name: null,
    avatar: null,
    banner: null,
  });
  await queue.drain(2000);

  const initial = eventsOf('profile_update').at(-1);
  assert.strictEqual(initial.metadata.initial, true, 'el primer avistamiento se marca como inicial');
  assert.ok(initial.metadata.after.avatar_url.includes('/embed/avatars/'), 'sin avatar usa el default');
});

test('presence: desconexión', async () => {
  const runtime = rt();
  await runtime.handlePresence({
    user: { id: TARGET_ID },
    guild_id: GUILD_ID,
    status: 'offline',
    activities: [],
    client_status: {},
  });
  await queue.drain(2000);

  const offline = eventsOf('presence').find((event) => event.metadata.to === 'offline');
  assert.ok(offline, 'tiene que registrar la desconexión');
});

test('targets: touch actualiza el username del owner', async () => {
  await targets.add(OWNER, TARGET_ID, 'target', 'novio');
  await targets.refresh(OWNER, { force: true });
  await targets.touch(OWNER, TARGET_ID, 'target nuevo');

  const row = store.get('targets').find(
    (entry) => entry.user_id === TARGET_ID && entry.owner === OWNER
  );
  assert.strictEqual(row.username, 'target nuevo');

  await targets.add(OTHER, '555555555555555555', 'otra', null);
  const mine = await targets.list(OWNER);
  assert.strictEqual(mine.length, 1, 'cada owner ve solo sus objetivos');
  assert.strictEqual(mine[0].user_id, TARGET_ID);
});

/* ------------------------------------------------------------------ http -- */

async function listen() {
  const server = startServer(0);
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, username, password, hwid) {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, hwid }),
  });
  const body = await response.json();
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

const HWID_A = 'a'.repeat(64);
const HWID_B = 'b'.repeat(64);

test('api: login, bootstrap, summary, targets y filtros', async () => {
  await queue.drain(2000);
  const { server, base } = await listen();
  rt();

  try {
    const bad = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: OWNER, password: 'incorrecta' }),
    });
    assert.strictEqual(bad.status, 401);

    const { cookie, body: session } = await login(base, OWNER, 'test-password', HWID_A);
    assert.ok(cookie, 'el login emite cookie de sesión');
    assert.strictEqual(session.account.username, OWNER);
    assert.strictEqual(session.account.role, 'admin', 'la cuenta del deploy es admin');

    const unauthorized = await fetch(`${base}/api/summary`);
    assert.strictEqual(unauthorized.status, 401);

    const health = await fetch(`${base}/health`);
    assert.strictEqual(health.status, 200);

    const bootstrap = await (await fetch(`${base}/api/bootstrap`, { headers: { cookie } })).json();
    assert.ok(bootstrap.summary.total24h >= 5, `esperaba eventos, llegaron ${bootstrap.summary.total24h}`);
    assert.strictEqual(bootstrap.targets.length, 1);
    assert.ok(bootstrap.summary.presence[TARGET_ID], 'la presencia del target tiene que estar en el summary');
    assert.strictEqual(bootstrap.guilds.length, 1);
    assert.strictEqual(bootstrap.events.length, bootstrap.events.slice(0, 60).length);
    assert.ok(bootstrap.events.every((event) => String(event.owner) === OWNER), 'el feed solo trae eventos del owner');

    const add = await fetch(`${base}/api/targets`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: '444444444444444444', note: 'otro' }),
    });
    assert.strictEqual(add.status, 200);
    const added = await add.json();
    assert.strictEqual(added.target.username, 'nuevo', 'resuelve el username desde los eventos');

    const invalid = await fetch(`${base}/api/targets`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 'no-es-un-id' }),
    });
    assert.strictEqual(invalid.status, 400);

    const list = await (await fetch(`${base}/api/targets`, { headers: { cookie } })).json();
    assert.strictEqual(list.targets.length, 2);

    const messages = await (
      await fetch(`${base}/api/events?type=message&limit=50`, { headers: { cookie } })
    ).json();
    assert.ok(messages.events.length >= 3, 'el filtro message agrupa create, edit y delete');
    assert.ok(new Set(messages.events.map((event) => event.event_type)).has('message_delete'));

    const onlyUser = await (
      await fetch(`${base}/api/events?user=${TARGET_ID}&type=message&limit=10`, { headers: { cookie } })
    ).json();
    assert.ok(onlyUser.events.length >= 1);
    assert.ok(onlyUser.events.every((event) => event.user_id === TARGET_ID));

    const search = await (
      await fetch(`${base}/api/events?q=hola&limit=10`, { headers: { cookie } })
    ).json();
    assert.ok(search.events.length >= 1, 'la búsqueda encuentra el contenido');

    const del = await fetch(`${base}/api/targets/444444444444444444`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.strictEqual(del.status, 200);
    const afterDelete = await (await fetch(`${base}/api/targets`, { headers: { cookie } })).json();
    assert.strictEqual(afterDelete.targets.length, 1);

    const settings = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
    assert.strictEqual(typeof settings.account.hasToken, 'boolean');
    assert.ok(!JSON.stringify(settings).includes('fake.token.value'), 'el token nunca sale hacia el cliente');

    const members = await (
      await fetch(`${base}/api/members?guild=${GUILD_ID}`, { headers: { cookie } })
    ).json();
    assert.strictEqual(members.members.length, 1);
    assert.strictEqual(members.members[0].id, TARGET_ID);
  } finally {
    server.close();
  }
});

test('api: registro abierto, HWID, recuperación y desvinculado', async () => {
  const { server, base } = await listen();

  try {
    const credentials = { username: 'cuenta', password: 'clave-segura-123' };

    const register = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_A, hwid_label: 'Windows · Chrome' }),
    });
    assert.strictEqual(register.status, 200, 'cualquiera puede crearse su cuenta, sin key');
    const registered = await register.json();
    assert.strictEqual(registered.account.role, 'user', 'la cuenta del deploy ya ocupa el lugar de admin');

    const noHwid = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sinhu', password: 'clave-segura-123' }),
    });
    assert.strictEqual(noHwid.status, 400, 'sin identidad de dispositivo no se alta');

    const duplicate = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_A }),
    });
    assert.strictEqual(duplicate.status, 409, 'el usuario no se puede repetir');

    const short = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'flaco', password: 'corta', hwid: HWID_A }),
    });
    assert.strictEqual(short.status, 400);

    const otherDevice = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_B }),
    });
    assert.strictEqual(otherDevice.status, 403, 'la cuenta está atada al primer dispositivo');
    assert.match((await otherDevice.json()).error, /otro dispositivo/);

    const sameDevice = await login(base, credentials.username, credentials.password, HWID_A);
    assert.strictEqual(sameDevice.response.status, 200);

    const badRecover = await fetch(`${base}/api/recover-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, password: 'no-es-la-clave', hwid: HWID_B }),
    });
    assert.strictEqual(badRecover.status, 401, 'recuperar exige la contraseña real');

    const recover = await fetch(`${base}/api/recover-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_B, hwid_label: 'Mac · Safari' }),
    });
    assert.strictEqual(recover.status, 200);
    const recoverCookie = recover.headers.get('set-cookie').split(';')[0];

    const relinked = await login(base, credentials.username, credentials.password, HWID_B);
    assert.strictEqual(relinked.response.status, 200, 'la cuenta quedó atada al dispositivo nuevo');

    const oldDevice = await login(base, credentials.username, credentials.password, HWID_A);
    assert.strictEqual(oldDevice.response.status, 403, 'el dispositivo viejo queda afuera');

    const unlink = await fetch(`${base}/api/account/hwid`, {
      method: 'DELETE',
      headers: { cookie: recoverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: credentials.password }),
    });
    assert.strictEqual(unlink.status, 200);

    const afterUnlink = await login(base, credentials.username, credentials.password, HWID_A);
    assert.strictEqual(afterUnlink.response.status, 200, 'desvinculado, se puede entrar desde otro dispositivo');

    const legacyAccount = await fetch(`${base}/api/account`, {
      method: 'PUT',
      headers: { cookie: afterUnlink.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ current: credentials.password, password: 'otra-clave-super-123' }),
    });
    assert.strictEqual(legacyAccount.status, 200, 'una cuenta normal sí puede cambiar la contraseña');
    const newCookie = legacyAccount.headers.get('set-cookie').split(';')[0];
    const relogged = await login(base, credentials.username, 'otra-clave-super-123', HWID_A);
    assert.strictEqual(relogged.response.status, 200, 'la sesión vieja se invalida y la nueva entra');
    assert.ok(newCookie && newCookie !== recoverCookie, 'la nueva contraseña reemite la cookie');

    const oldSession = await fetch(`${base}/api/summary`, { headers: { cookie: recoverCookie } });
    assert.strictEqual(oldSession.status, 401, 'la cookie de la versión anterior no sirve más');
  } finally {
    server.close();
  }
});

test('api: la cuenta del deploy no cambia contraseña desde el panel', async () => {
  const { server, base } = await listen();

  try {
    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);
    const blocked = await fetch(`${base}/api/account`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ current: 'test-password', password: 'nueva-clave-123' }),
    });
    assert.strictEqual(blocked.status, 409, 'con DASHBOARD_PASSWORD el cambio se hace en el deploy');
  } finally {
    server.close();
  }
});

test('api: token de Discord por cuenta, sin rutas de key', async () => {
  const { server, base } = await listen();
  bot.__setTokenValidator(async (token) => ({
    id: SELF_ID,
    username: 'watcher',
    global_name: 'Watcher',
    avatar: bot.avatarUrl(SELF_ID, 'hash'),
  }));

  try {
    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);

    const empty = await fetch(`${base}/api/settings/token`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ token: '  ' }),
    });
    assert.strictEqual(empty.status, 400);

    const saved = await fetch(`${base}/api/settings/token`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'otro.token.valido' }),
    });
    assert.strictEqual(saved.status, 200);
    const savedBody = await saved.json();
    assert.strictEqual(savedBody.account.discord.linked, true);
    assert.strictEqual(savedBody.account.hasToken, true);
    assert.ok(!JSON.stringify(savedBody).includes('otro.token.valido'), 'el token no vuelve al cliente');

    const record = await accounts.getRecord(OWNER);
    assert.strictEqual(record.discord_token, 'otro.token.valido', 'queda guardado en la cuenta');

    const settings = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
    assert.strictEqual(settings.account.discord.username, 'Watcher');
    assert.strictEqual(settings.db.configured, true);

    const reconnected = await fetch(`${base}/api/bot/reconnect`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.strictEqual(reconnected.status, 200);

    const cleared = await fetch(`${base}/api/settings/token`, { method: 'DELETE', headers: { cookie } });
    assert.strictEqual(cleared.status, 200);
    const afterClear = await accounts.getRecord(OWNER);
    assert.strictEqual(afterClear.discord_token, null, 'quitar el token limpia la cuenta');

    for (const route of ['/api/keys', '/api/registration-key', '/api/settings/test']) {
      const gone = await fetch(`${base}${route}`, {
        method: route === '/api/settings/test' ? 'POST' : 'GET',
        headers: { cookie, 'content-type': 'application/json' },
        body: route === '/api/settings/test' ? '{}' : undefined,
      });
      assert.strictEqual(gone.status, 404, `${route} ya no existe`);
    }
  } finally {
    bot.__setTokenValidator(null);
    server.close();
  }
});

test('api: dos cuentas no se ven entre sí', async () => {
  const { server, base } = await listen();
  const NEIGHBOUR = 'aislada';

  try {
    await targets.add(NEIGHBOUR, '666666666666666666', 'objetivo-ajeno', null);
    store.get('events').push({
      owner: NEIGHBOUR,
      event_type: 'message',
      user_id: '666666666666666666',
      username: 'objetivo-ajeno',
      content: 'secreto de otra cuenta',
      created_at: new Date().toISOString(),
      metadata: {},
      id: nextId++,
    });

    const register = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: NEIGHBOUR, password: 'clave-de-vecina-1', hwid: 'c'.repeat(64) }),
    });
    assert.strictEqual(register.status, 200);
    const otherCookie = register.headers.get('set-cookie').split(';')[0];

    const ownEvents = await (await fetch(`${base}/api/events`, { headers: { cookie: otherCookie } })).json();
    assert.ok(ownEvents.events.length >= 1);
    assert.ok(ownEvents.events.every((event) => event.owner === NEIGHBOUR), 'solo ve sus eventos');
    assert.ok(!JSON.stringify(ownEvents).includes('hola editado'), 'no ve los eventos de tester');

    const ownTargets = await (await fetch(`${base}/api/targets`, { headers: { cookie: otherCookie } })).json();
    assert.strictEqual(ownTargets.targets.length, 1);
    assert.strictEqual(ownTargets.targets[0].user_id, '666666666666666666');

    const ownSummary = await (await fetch(`${base}/api/summary`, { headers: { cookie: otherCookie } })).json();
    assert.strictEqual(ownSummary.targets, 1);
    assert.strictEqual(ownSummary.total24h, 1);
  } finally {
    server.close();
  }
});

test('api: logout limpia la cookie y /api/session informa sin sesión', async () => {
  const { server, base } = await listen();

  try {
    const anonymous = await (await fetch(`${base}/api/session`)).json();
    assert.strictEqual(anonymous.authed, false);

    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);
    const authed = await (await fetch(`${base}/api/session`, { headers: { cookie } })).json();
    assert.strictEqual(authed.authed, true);
    assert.strictEqual(authed.username, OWNER);

    const logout = await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
    assert.strictEqual(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

    const after = await fetch(`${base}/api/bootstrap`, { headers: { cookie } });
    assert.strictEqual(after.status, 401, 'la cookie borrada no vuelve a servir');
  } finally {
    server.close();
  }
});

/* ------------------------------------------------------------------ admin -- */

const json = (cookie) => ({ 'content-type': 'application/json', cookie });

async function registerUser(base, { username, password, hwid, agent }) {
  const response = await fetch(`${base}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': agent || 'SmokeTest/1.0 (Windows NT 10.0)' },
    body: JSON.stringify({ username, password, hwid, hwid_label: 'Windows · Chrome' }),
  });
  const body = await response.json();
  return { response, body, cookie: response.headers.get('set-cookie')?.split(';')[0] || '' };
}

test('admin: acceso, uso de la página y token enmascarado', async () => {
  const { server, base } = await listen();
  const NAME = 'gestionada';

  try {
    const anon = await fetch(`${base}/api/admin/accounts`);
    assert.strictEqual(anon.status, 401, 'la gestión exige sesión');

    const victim = await registerUser(base, { username: NAME, password: 'clave-de-gestion-1', hwid: 'd'.repeat(64) });
    assert.strictEqual(victim.response.status, 200);

    const notAdmin = await fetch(`${base}/api/admin/accounts`, { headers: { cookie: victim.cookie } });
    assert.strictEqual(notAdmin.status, 403, 'un usuario común no ve la gestión');
    assert.strictEqual((await notAdmin.json()).code, 'forbidden');

    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);
    await fetch(`${base}/api/bootstrap`, { headers: { cookie } });

    const list = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    assert.strictEqual(list.window, '7d');

    const row = list.accounts.find((entry) => entry.username === NAME);
    assert.ok(row, 'la cuenta registrada aparece en la lista');
    assert.strictEqual(row.role, 'user');
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.self, false);
    assert.strictEqual(row.legacy, false);
    assert.strictEqual(row.hwid_linked, true);
    assert.strictEqual(row.hwid_label, 'Windows · Chrome');
    assert.match(String(row.last_ip), /127\.0\.0\.1|::1/, 'la ip del registro queda guardada');
    assert.match(String(row.user_agent), /SmokeTest/, 'el navegador del registro queda guardado');
    assert.ok(row.login_count >= 1);
    assert.ok(row.created_at);

    const mine = list.accounts.find((entry) => entry.username === OWNER);
    assert.strictEqual(mine.legacy, true, 'la cuenta del deploy se marca como legacy');
    assert.strictEqual(mine.self, true);
    assert.ok(mine.boot_count >= 1, 'las aperturas del panel se cuentan');
    assert.ok(mine.last_seen_at, 'la actividad reciente queda registrada');
    assert.ok(list.totals.admins >= 1);

    await accounts.saveDiscord(NAME, {
      token: 'victima.token.secreto.victima.token',
      userId: '777777777777777777',
      username: 'Victima',
      avatar: null,
    });
    const withToken = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    const updated = withToken.accounts.find((entry) => entry.username === NAME);
    assert.strictEqual(updated.hasToken, true);
    assert.strictEqual(updated.discord.username, 'Victima');
    assert.match(String(updated.discord.token_preview), /…/, 'el token se muestra recortado');
    assert.ok(!JSON.stringify(withToken).includes('secreto'), 'el token completo nunca sale al panel');
    assert.ok(withToken.totals.withToken >= 1);
  } finally {
    server.close();
  }
});

test('admin: bloquear corta la sesión y desbloquear la devuelve', async () => {
  const { server, base } = await listen();
  const NAME = 'bloqueada';
  const CLAVE = 'clave-de-bloqueada-1';

  try {
    const victim = await registerUser(base, { username: NAME, password: CLAVE, hwid: 'e'.repeat(64) });
    const alive = await fetch(`${base}/api/bootstrap`, { headers: { cookie: victim.cookie } });
    assert.strictEqual(alive.status, 200, 'antes del bloqueo la sesión funciona');

    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);

    const self = await fetch(`${base}/api/admin/accounts/${OWNER}/status`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ status: 'blocked' }),
    });
    assert.strictEqual(self.status, 409, 'el admin no se bloquea a sí mismo');

    const invalid = await fetch(`${base}/api/admin/accounts/${NAME}/status`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ status: 'deleting' }),
    });
    assert.strictEqual(invalid.status, 400);

    const missing = await fetch(`${base}/api/admin/accounts/noexiste/status`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ status: 'blocked' }),
    });
    assert.strictEqual(missing.status, 404);

    const block = await fetch(`${base}/api/admin/accounts/${NAME}/status`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ status: 'blocked', reason: 'comparte la cuenta' }),
    });
    assert.strictEqual(block.status, 200);
    assert.strictEqual((await block.json()).account.status, 'blocked');

    const dead = await fetch(`${base}/api/bootstrap`, { headers: { cookie: victim.cookie } });
    assert.strictEqual(dead.status, 401, 'la cookie viva deja de servir al bloquear');

    const relog = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: NAME, password: CLAVE, hwid: 'e'.repeat(64) }),
    });
    assert.strictEqual(relog.status, 403);
    const relogBody = await relog.json();
    assert.strictEqual(relogBody.code, 'blocked');
    assert.match(relogBody.error, /comparte la cuenta/, 'el motivo llega en el error de login');

    const listed = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    const blocked = listed.accounts.find((entry) => entry.username === NAME);
    assert.strictEqual(blocked.status, 'blocked');
    assert.strictEqual(blocked.block_reason, 'comparte la cuenta');
    assert.ok(listed.totals.blocked >= 1);

    const unblock = await fetch(`${base}/api/admin/accounts/${NAME}/status`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ status: 'active' }),
    });
    assert.strictEqual(unblock.status, 200);

    const back = await login(base, NAME, CLAVE, 'e'.repeat(64));
    assert.strictEqual(back.response.status, 200, 'desbloqueada, vuelve a entrar');
    const clean = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    assert.strictEqual(clean.accounts.find((entry) => entry.username === NAME).block_reason, null);
  } finally {
    server.close();
  }
});

test('admin: contraseña nueva, rol y desvinculado de equipo', async () => {
  const { server, base } = await listen();
  const NAME = 'resetme';
  const OLD = 'clave-vieja-de-reset';

  try {
    const victim = await registerUser(base, { username: NAME, password: OLD, hwid: 'f'.repeat(64) });
    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);

    const short = await fetch(`${base}/api/admin/accounts/${NAME}/password`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ password: 'corta' }),
    });
    assert.strictEqual(short.status, 400, 'respeta el mínimo de caracteres');

    const legacy = await fetch(`${base}/api/admin/accounts/${OWNER}/password`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ password: 'clave-nueva-1234' }),
    });
    assert.strictEqual(legacy.status, 409, 'la cuenta del deploy se cambia en el deploy');

    const reset = await fetch(`${base}/api/admin/accounts/${NAME}/password`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ password: 'clave-nueva-del-admin' }),
    });
    assert.strictEqual(reset.status, 200);

    const dead = await fetch(`${base}/api/summary`, { headers: { cookie: victim.cookie } });
    assert.strictEqual(dead.status, 401, 'resetear la contraseña cierra las sesiones abiertas');

    const oldKey = await login(base, NAME, OLD, 'f'.repeat(64));
    assert.strictEqual(oldKey.response.status, 401, 'la contraseña vieja ya no vale');

    const newKey = await login(base, NAME, 'clave-nueva-del-admin', 'f'.repeat(64));
    assert.strictEqual(newKey.response.status, 200, 'la nueva contraseña entra');

    const promote = await fetch(`${base}/api/admin/accounts/${NAME}/role`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ role: 'admin' }),
    });
    assert.strictEqual(promote.status, 200);
    const promoted = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    assert.strictEqual(promoted.accounts.find((e) => e.username === NAME).role, 'admin');
    assert.ok(promoted.totals.admins >= 2);

    const badRole = await fetch(`${base}/api/admin/accounts/${NAME}/role`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ role: 'root' }),
    });
    assert.strictEqual(badRole.status, 400);

    const demote = await fetch(`${base}/api/admin/accounts/${NAME}/role`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ role: 'user' }),
    });
    assert.strictEqual(demote.status, 200);

    const lastAdmin = await fetch(`${base}/api/admin/accounts/${OWNER}/role`, {
      method: 'POST', headers: json(cookie), body: JSON.stringify({ role: 'user' }),
    });
    assert.strictEqual(lastAdmin.status, 409, 'no puede quedar el panel sin admin');

    const unlink = await fetch(`${base}/api/admin/accounts/${NAME}/unlink`, { method: 'POST', headers: { cookie } });
    assert.strictEqual(unlink.status, 200);
    const afterUnlink = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    assert.strictEqual(afterUnlink.accounts.find((e) => e.username === NAME).hwid_linked, false);

    const otherDevice = await login(base, NAME, 'clave-nueva-del-admin', 'a'.repeat(64));
    assert.strictEqual(otherDevice.response.status, 200, 'desvinculada, entra desde cualquier equipo');
  } finally {
    server.close();
  }
});

test('admin: borrar una cuenta se lleva sus objetivos y sus eventos', async () => {
  const { server, base } = await listen();
  const NAME = 'borrada';

  try {
    const victim = await registerUser(base, { username: NAME, password: 'clave-de-borrado-1', hwid: '1'.repeat(64) });
    await targets.add(NAME, '888888888888888888', 'señuelo', null);
    store.get('events').push({
      owner: NAME,
      event_type: 'message',
      user_id: '888888888888888888',
      username: 'señuelo',
      content: 'contenido de la cuenta a borrar',
      created_at: new Date().toISOString(),
      metadata: {},
      id: nextId++,
    });
    bot.__setClient(NAME, fakeClient);
    assert.ok(bot.getClient(NAME), 'la cuenta tiene gateway antes del borrado');

    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);

    const self = await fetch(`${base}/api/admin/accounts/${OWNER}`, { method: 'DELETE', headers: { cookie } });
    assert.strictEqual(self.status, 409, 'el admin no se borra a sí mismo');

    const lastAdmin = await fetch(`${base}/api/admin/accounts/noexiste`, { method: 'DELETE', headers: { cookie } });
    assert.strictEqual(lastAdmin.status, 404);

    const del = await fetch(`${base}/api/admin/accounts/${NAME}`, { method: 'DELETE', headers: { cookie } });
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).removed, NAME);

    const list = await (await fetch(`${base}/api/admin/accounts`, { headers: { cookie } })).json();
    assert.ok(!list.accounts.some((entry) => entry.username === NAME), 'la cuenta desaparece de la gestión');
    assert.strictEqual(store.get('targets').filter((row) => row.owner === NAME).length, 0, 'sus objetivos se borran');
    assert.strictEqual(store.get('events').filter((row) => row.owner === NAME).length, 0, 'sus eventos se borran');
    assert.strictEqual(bot.getClient(NAME), null, 'el gateway de esa cuenta se libera');
    assert.strictEqual(await accounts.getRecord(NAME), null, 'el registro ya no existe');

    const again = await fetch(`${base}/api/admin/accounts/${NAME}`, { method: 'DELETE', headers: { cookie } });
    assert.strictEqual(again.status, 404, 'borrar dos veces avisa que no existe');

    const deadSession = await fetch(`${base}/api/bootstrap`, { headers: { cookie: victim.cookie } });
    assert.strictEqual(deadSession.status, 401);
  } finally {
    server.close();
  }
});

/* -------------------------------------------------------------- historial -- */

function pushEvent(row) {
  const stored = {
    owner: OWNER,
    event_type: 'message',
    user_id: TARGET_ID,
    username: 'target',
    guild_id: GUILD_ID,
    guild_name: 'Server Test',
    channel_id: CHANNEL_ID,
    channel_name: 'general',
    content: '',
    metadata: {},
    created_at: new Date().toISOString(),
    ...row,
    id: nextId++,
  };
  store.get('events').push(stored);
  return stored;
}

async function deleteHistory(base, cookie, name, body) {
  const response = await fetch(`${base}/api/admin/accounts/${name}/history`, {
    method: 'DELETE',
    headers: json(cookie),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('historial: el admin lee el historial de una cuenta y borra lo que elige', async () => {
  const { server, base } = await listen();
  const NAME = 'historica';

  try {
    const victim = await registerUser(base, { username: NAME, password: 'clave-de-historial-1', hwid: 'f'.repeat(64) });
    assert.strictEqual(victim.response.status, 200);

    const mine = [
      pushEvent({ owner: NAME, event_type: 'message', content: 'secreto uno' }),
      pushEvent({ owner: NAME, event_type: 'voice_join' }),
      pushEvent({ owner: NAME, event_type: 'presence' }),
    ];
    const foreign = pushEvent({ owner: OWNER, content: 'no es de esa cuenta' });

    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);

    const denied = await fetch(`${base}/api/admin/accounts/${NAME}/history`, { headers: { cookie: victim.cookie } });
    assert.strictEqual(denied.status, 403, 'leer el historial es tarea de admin');

    const missing = await fetch(`${base}/api/admin/accounts/nadie/history`, { headers: { cookie } });
    assert.strictEqual(missing.status, 404, 'sin cuenta no hay historial');

    const page = await (await fetch(`${base}/api/admin/accounts/${NAME}/history`, { headers: { cookie } })).json();
    assert.strictEqual(page.account.username, NAME);
    assert.strictEqual(page.total, 3);
    assert.strictEqual(page.events.length, 3);
    assert.strictEqual(page.hasMore, false);
    assert.ok(page.events.every((event) => event.owner === NAME), 'sólo devuelve eventos de esa cuenta');
    assert.ok(page.newestAt && page.oldestAt, 'marca el rango leído');

    const byType = await (await fetch(`${base}/api/admin/accounts/${NAME}/history?type=message`, { headers: { cookie } })).json();
    assert.strictEqual(byType.total, 1, 'el filtro de tipo achica el total');
    assert.strictEqual(byType.events[0].event_type, 'message');

    const byVoice = await (await fetch(`${base}/api/admin/accounts/${NAME}/history?type=voice`, { headers: { cookie } })).json();
    assert.strictEqual(byVoice.total, 1, 'voz agrupa join/leave/move');

    const byText = await (await fetch(`${base}/api/admin/accounts/${NAME}/history?q=secreto`, { headers: { cookie } })).json();
    assert.strictEqual(byText.total, 1);

    const byDate = await (await fetch(
      `${base}/api/admin/accounts/${NAME}/history?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`,
      { headers: { cookie } }
    )).json();
    assert.strictEqual(byDate.total, 0, 'un rango futuro no lee nada');

    const mixed = await deleteHistory(base, cookie, NAME, {
      scope: 'ids',
      ids: [mine[0].id, foreign.id, 'basura', '99999999999999999999999'],
    });
    assert.strictEqual(mixed.status, 200);
    assert.strictEqual(mixed.body.removed, 1, 'de la selección sólo se borra lo de esa cuenta');
    assert.ok(store.get('events').some((row) => row.id === foreign.id), 'el evento de otro owner queda intacto');

    const afterIds = await (await fetch(`${base}/api/admin/accounts/${NAME}/history`, { headers: { cookie } })).json();
    assert.strictEqual(afterIds.total, 2);

    const lazy = await deleteHistory(base, cookie, NAME, { scope: 'query' });
    assert.strictEqual(lazy.status, 400, 'borrar por filtro exige un filtro');

    const byQuery = await deleteHistory(base, cookie, NAME, { scope: 'query', type: 'presence' });
    assert.strictEqual(byQuery.status, 200);
    assert.strictEqual(byQuery.body.removed, 1);

    const everything = await deleteHistory(base, cookie, NAME, { scope: 'all' });
    assert.strictEqual(everything.status, 200);
    assert.strictEqual(everything.body.removed, 1);
    assert.strictEqual(store.get('events').filter((row) => row.owner === NAME).length, 0, 'el historial queda vacío');
    assert.ok(store.get('events').some((row) => row.owner === OWNER), 'el historial del admin no se toca');

    const feed = await (await fetch(`${base}/api/events`, { headers: { cookie: victim.cookie } })).json();
    assert.strictEqual(feed.events.length, 0, 'el feed de la cuenta también queda vacío');

    const empty = await (await fetch(`${base}/api/admin/accounts/${NAME}/history`, { headers: { cookie } })).json();
    assert.strictEqual(empty.total, 0);
    assert.strictEqual(empty.events.length, 0);
    assert.strictEqual(empty.hasMore, false);
  } finally {
    server.close();
  }
});

test('historial: una decisión vacía o imposible devuelve 400 y no borra nada', async () => {
  const { server, base } = await listen();
  const NAME = 'historial-tenaz';

  try {
    await registerUser(base, { username: NAME, password: 'clave-de-historial-2', hwid: '8'.repeat(64) });
    const kept = pushEvent({ owner: NAME, content: 'sigo acá' });
    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);

    const noScope = await deleteHistory(base, cookie, NAME, {});
    assert.strictEqual(noScope.status, 400, 'hay que decir qué se borra');

    const noIds = await deleteHistory(base, cookie, NAME, { scope: 'ids', ids: [] });
    assert.strictEqual(noIds.status, 400);

    const junkIds = await deleteHistory(base, cookie, NAME, { scope: 'ids', ids: ['abc', null, '2.5'] });
    assert.strictEqual(junkIds.status, 400, 'ids que no son números se rechazan');

    const tooMany = await deleteHistory(base, cookie, NAME, {
      scope: 'ids',
      ids: Array.from({ length: 501 }, (unused, index) => String(index + 1)),
    });
    assert.strictEqual(tooMany.status, 400, 'el lote de ids tiene techo');

    const future = await deleteHistory(base, cookie, NAME, {
      scope: 'query',
      from: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.strictEqual(future.status, 200, 'un filtro válido borra aunque no coincida');
    assert.strictEqual(future.body.removed, 0);

    assert.ok(store.get('events').some((row) => row.id === kept.id), 'ningún rechazo tocó el historial');
  } finally {
    server.close();
  }
});

test('historial: la cuenta del deploy tiene historial aunque no tenga fila en accounts', async () => {
  const { server, base } = await listen();

  try {
    pushEvent({ owner: OWNER, content: 'evento del deploy' });
    const { cookie } = await login(base, OWNER, 'test-password', HWID_A);
    assert.ok(await accounts.getRecord(OWNER), 'el login del deploy crea su fila');

    // Deploy recién migrado: la cuenta vive en las variables pero aún no tiene registro.
    await accounts.removeAccount(OWNER);
    accounts.__reset();
    assert.strictEqual(await accounts.getRecord(OWNER), null, 'sin fila de cuenta');

    const page = await (await fetch(`${base}/api/admin/accounts/${OWNER}/history`, { headers: { cookie } })).json();
    assert.ok(Array.isArray(page.events) && page.total >= 1, 'aun así se puede leer su historial');

    const mine = page.events.map((event) => event.id);
    const out = await deleteHistory(base, cookie, OWNER, { scope: 'ids', ids: mine });
    assert.strictEqual(out.status, 200, 'y se puede borrar');
    assert.strictEqual(out.body.removed, mine.length);

    await login(base, OWNER, 'test-password', HWID_A);
    assert.ok(await accounts.getRecord(OWNER), 'el login siguiente vuelve a provisionar la cuenta');
  } finally {
    server.close();
  }
});

/* ---------------------------------------------------------------- runner -- */

(async () => {
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}`);
      console.error(`     ${error.stack || error.message}`);
    }
  }

  await queue.drain(2000);
  await bot.stopAll();

  console.log('');
  console.log(failed ? `${failed} test(s) fallaron` : `todo ok (${tests.length} tests)`);
  process.exit(failed ? 1 : 0);
})();
