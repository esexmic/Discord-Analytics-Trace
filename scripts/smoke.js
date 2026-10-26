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
