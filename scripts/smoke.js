'use strict';

/**
 * Smoke test sin credenciales: reemplaza Supabase por un store en memoria y el
 * gateway por objetos falsos, y ejercita el pipeline completo (handlers ->
 * cola -> "DB" -> API HTTP).
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
process.env.ACCESS_KEY = 'smoke-access-key-123456';
process.env.TRACK_ALL = 'true';
process.env.PORT = '0';

const assert = require('assert');
const { once } = require('events');
const { createFakeSupabase } = require('./fake-supabase');

const db = require('../src/db');
const store = new Map();
store.set('events', []);
store.set('targets', []);

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
const { startServer } = require('../src/server');

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
  users: { cache: new Map([[TARGET_ID, targetUser]]), fetch: async () => targetUser },
};

bot.__setClient(fakeClient);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/* ------------------------------------------------------------- handlers --- */

test('presence: conexión con actividad y dispositivos', async () => {
  await bot.handlePresence({
    user: { id: TARGET_ID },
    guild_id: GUILD_ID,
    status: 'online',
    activities: [{ type: 2, name: 'Spotify', details: 'Some song' }],
    client_status: { desktop: 'online', mobile: 'online' },
  });

  const before = store.get('events').length;
  await bot.handlePresence({
    user: { id: TARGET_ID },
    guild_id: GUILD_ID,
    status: 'online',
    activities: [],
    client_status: { desktop: 'online' },
  });
  assert.strictEqual(store.get('events').length, before, 'no debe duplicar la misma transición');
});

test('message + edit + delete', async () => {
  bot.__setClient(fakeClient);

  await bot.handleMessage({
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

  await bot.handleMessageUpdate(null, {
    id: 'm1',
    guild,
    channel,
    author: targetUser,
    content: 'hola editado',
    attachments: new Map(),
  });

  await queue.drain(2000);

  const edited = store.get('events').find((event) => event.event_type === 'message_edit');
  assert.ok(edited, 'tiene que existir el evento de edición');
  assert.strictEqual(edited.old_content, 'hola');
  assert.strictEqual(edited.content, 'hola editado');
  assert.strictEqual(edited.channel_id, CHANNEL_ID);
  assert.strictEqual(edited.guild_id, GUILD_ID);

  await bot.handleMessageDelete({ id: 'm1', guild, channel, author: targetUser });

  await queue.drain(2000);

  const deleted = store.get('events').find((event) => event.event_type === 'message_delete');
  assert.ok(deleted, 'tiene que existir el evento de borrado');
  assert.strictEqual(deleted.content, 'hola editado');
});

test('voice: join, stream y leave con duración', async () => {
  await bot.handleVoice({
    guild_id: GUILD_ID,
    user_id: TARGET_ID,
    channel_id: CHANNEL_ID,
    self_stream: false,
    self_video: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 1200));

  await bot.handleVoice({
    guild_id: GUILD_ID,
    user_id: TARGET_ID,
    channel_id: CHANNEL_ID,
    self_stream: true,
    self_video: false,
  });

  await bot.handleVoice({
    guild_id: GUILD_ID,
    user_id: TARGET_ID,
    channel_id: null,
    self_stream: false,
    self_video: false,
  });

  await queue.drain(2000);

  const types = store.get('events').map((event) => event.event_type);
  assert.ok(types.includes('voice_join'));
  assert.ok(types.includes('voice_stream'));
  assert.ok(types.includes('voice_leave'));

  const leave = store.get('events').find((event) => event.event_type === 'voice_leave');
  assert.ok(leave.metadata.seconds >= 1, 'la duración se calcula con el join');
});

test('profile: nombre, avatar animado, banner y apodo', async () => {
  bot.__setClient(fakeClient);
  bot.__seed();

  await bot.handleUserUpdate({
    id: TARGET_ID,
    username: 'target_renamed',
    global_name: 'Target Nuevo',
    discriminator: '0',
    avatar: 'a_abcdef',
    banner: 'banner_hash',
  });

  await queue.drain(2000);

  const profile = store.get('events').filter((event) => event.event_type === 'profile_update').at(-1);
  assert.ok(profile, 'tiene que existir el evento de perfil');
  assert.strictEqual(profile.metadata.changes.username.to, 'target_renamed');
  assert.strictEqual(profile.metadata.changes.global_name.to, 'Target Nuevo');
  assert.ok(profile.metadata.after.avatar_url.includes('/avatars/'));
  assert.ok(profile.metadata.after.avatar_url.includes('.gif'), 'el avatar animado usa gif');
  assert.ok(profile.metadata.after.banner_url.includes('/banners/'));
  assert.match(profile.content, /nombre: target → target_renamed/);

  await bot.handleMemberUpdate({
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

  const nick = store.get('events').filter((event) => event.event_type === 'profile_update').at(-1);
  assert.strictEqual(nick.metadata.nick.to, 'apodo nuevo');
  assert.strictEqual(nick.guild_id, GUILD_ID);

  await bot.handleUserUpdate({
    id: '444444444444444444',
    username: 'nuevo',
    global_name: null,
    avatar: null,
    banner: null,
  });

  await queue.drain(2000);

  const initial = store.get('events').filter((event) => event.event_type === 'profile_update').at(-1);
  assert.strictEqual(initial.metadata.initial, true, 'el primer avistamiento se marca como inicial');
  assert.ok(initial.metadata.after.avatar_url.includes('/embed/avatars/'), 'sin avatar usa el default');
});

test('presence: desconexión', async () => {
  await bot.handlePresence({
    user: { id: TARGET_ID },
    guild_id: GUILD_ID,
    status: 'offline',
    activities: [],
    client_status: {},
  });

  await queue.drain(2000);

  const offline = store.get('events').find(
    (event) => event.event_type === 'presence' && event.metadata.to === 'offline'
  );
  assert.ok(offline, 'tiene que registrar la desconexión');
});

test('targets: touch actualiza el username', async () => {
  await targets.refresh();
  await targets.add(TARGET_ID, 'target', 'novio');
  await targets.touch(TARGET_ID, 'target nuevo');

  const row = store.get('targets').find((entry) => entry.user_id === TARGET_ID);
  assert.strictEqual(row.username, 'target nuevo');
});

/* ---------------------------------------------------------------- http ---- */

test('api: login, auth, summary, targets y eventos', async () => {
  await queue.drain(2000);
  const server = startServer(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const bad = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'incorrecta' }),
    });
    assert.strictEqual(bad.status, 401);

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'test-password' }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const unauthorized = await fetch(`${base}/api/summary`);
    assert.strictEqual(unauthorized.status, 401);

    const health = await fetch(`${base}/health`);
    assert.strictEqual(health.status, 200);

    const summary = await (await fetch(`${base}/api/summary`, { headers: { cookie } })).json();
    assert.ok(summary.total24h >= 5, `esperaba eventos, llegaron ${summary.total24h}`);
    assert.strictEqual(summary.targets, 1);
    assert.ok(summary.presence[TARGET_ID], 'la presencia del target tiene que estar en el summary');

    const add = await fetch(`${base}/api/targets`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: '444444444444444444', note: 'otro' }),
    });
    assert.strictEqual(add.status, 200);

    const list = await (await fetch(`${base}/api/targets`, { headers: { cookie } })).json();
    assert.strictEqual(list.targets.length, 2);

    const events = await (
      await fetch(`${base}/api/events?user=${TARGET_ID}&type=message&limit=10`, { headers: { cookie } })
    ).json();
    assert.strictEqual(events.events.length, 1);
    assert.strictEqual(events.events[0].content, 'hola');

    const guilds = await (await fetch(`${base}/api/guilds`, { headers: { cookie } })).json();
    assert.strictEqual(guilds.guilds.length, 1);
    assert.strictEqual(guilds.guilds[0].name, 'Server Test');
  } finally {
    server.close();
  }
});

test('api: ajustes, registro con key y HWID, cuenta legacy protegida', async () => {
  const server = startServer(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'test-password' }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const session = await (await fetch(`${base}/api/session`)).json();
    assert.strictEqual(session.needsSetup, false);

    const HWID_A = 'a'.repeat(64);
    const HWID_B = 'b'.repeat(64);
    const credentials = { username: 'cuenta', password: 'clave-segura-123' };

    const wrongKey = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, key: 'key-incorrecta', hwid: HWID_A }),
    });
    assert.strictEqual(wrongKey.status, 403, 'sin la key de acceso no se crea cuenta');

    const register = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...credentials,
        key: 'smoke-access-key-123456',
        hwid: HWID_A,
        hwid_label: 'Windows · Chrome',
      }),
    });
    assert.strictEqual(register.status, 200);
    const registered = await register.json();
    assert.strictEqual(registered.role, 'user', 'el primer admin es la cuenta del deploy');

    const duplicate = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, key: 'smoke-access-key-123456', hwid: HWID_A }),
    });
    assert.strictEqual(duplicate.status, 409, 'el usuario no se puede repetir');

    const otherDevice = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_B }),
    });
    assert.strictEqual(otherDevice.status, 403, 'la cuenta está atada al primer dispositivo');
    assert.match((await otherDevice.json()).error, /otro dispositivo/);

    const sameDevice = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_A }),
    });
    assert.strictEqual(sameDevice.status, 200);

    const recoverBadKey = await fetch(`${base}/api/recover-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, key: 'mala', hwid: HWID_B }),
    });
    assert.strictEqual(recoverBadKey.status, 403, 'la recuperación exige la key de acceso');

    const recover = await fetch(`${base}/api/recover-device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, key: 'smoke-access-key-123456', hwid: HWID_B }),
    });
    assert.strictEqual(recover.status, 200);
    const recoverCookie = recover.headers.get('set-cookie').split(';')[0];

    const relinked = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_B }),
    });
    assert.strictEqual(relinked.status, 200, 'la cuenta quedó atada al dispositivo nuevo');

    const unlink = await fetch(`${base}/api/account/hwid`, {
      method: 'DELETE',
      headers: { cookie: recoverCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: credentials.password }),
    });
    assert.strictEqual(unlink.status, 200);

    const afterUnlink = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...credentials, hwid: HWID_A }),
    });
    assert.strictEqual(afterUnlink.status, 200, 'desvinculado, se puede entrar desde otro dispositivo');

    const regkey = await (await fetch(`${base}/api/registration-key`, { headers: { cookie } })).json();
    assert.strictEqual(regkey.value, 'smoke-access-key-123456');
    assert.strictEqual(regkey.source, 'env');

    const view = await (await fetch(`${base}/api/settings`, { headers: { cookie } })).json();
    assert.strictEqual(view.hasDiscordToken, true);
    assert.strictEqual(view.hasSupabaseKey, true);
    assert.ok(view.discordTokenHint.includes('…'), 'el token se muestra enmascarado');
    assert.ok(!view.discordTokenHint.includes('fake.token.value'), 'el token completo nunca sale');
    assert.strictEqual(view.env.discordToken, true, 'la env marca el campo como bloqueado');

    const locked = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ discordToken: 'a'.repeat(60) }),
    });
    assert.strictEqual(locked.status, 400);
    assert.match((await locked.json()).error, /variable de entorno/);

    const account = await fetch(`${base}/api/account`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester2', current: 'test-password', password: 'nueva-clave-123' }),
    });
    assert.strictEqual(account.status, 409, 'con DASHBOARD_PASSWORD no se cambia desde el panel');

    const summary = await (await fetch(`${base}/api/summary`, { headers: { cookie } })).json();
    assert.strictEqual(summary.configured.supabase, true);
    assert.strictEqual(summary.configured.discord, true);
  } finally {
    server.close();
  }
});

test('api: keys — crear, usar con bearer y revocar', async () => {
  const server = startServer(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'test-password' }),
    });
    assert.strictEqual(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const created = await fetch(`${base}/api/keys`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'smoke' }),
    });
    assert.strictEqual(created.status, 200);
    const body = await created.json();
    assert.ok(body.token.startsWith('xyb_'), 'el token tiene el prefijo xyb_');
    assert.strictEqual(body.key.name, 'smoke');

    const viaHeader = await fetch(`${base}/api/summary`, { headers: { 'x-api-key': body.token } });
    assert.strictEqual(viaHeader.status, 200, 'la key sirve para leer');

    const viaBearer = await fetch(`${base}/api/events?limit=5`, {
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.strictEqual(viaBearer.status, 200, 'también acepta Authorization: Bearer');

    const sensitive = await fetch(`${base}/api/settings`, { headers: { 'x-api-key': body.token } });
    assert.strictEqual(sensitive.status, 403, 'la key no entra a credenciales');

    const botControl = await fetch(`${base}/api/bot/disconnect`, {
      method: 'POST',
      headers: { 'x-api-key': body.token },
    });
    assert.strictEqual(botControl.status, 403, 'la key no controla el bot');

    const list = await (await fetch(`${base}/api/keys`, { headers: { cookie } })).json();
    assert.strictEqual(list.keys.length, 1);
    assert.ok(!JSON.stringify(list).includes(body.token), 'el token completo no se vuelve a mostrar');
    assert.ok(list.keys[0].prefix.startsWith('xyb_'), 'la lista muestra solo el prefijo');

    const revoked = await fetch(`${base}/api/keys/${encodeURIComponent(body.key.id)}`, {
      method: 'DELETE',
      headers: { cookie },
    });
    assert.strictEqual(revoked.status, 200);

    const after = await fetch(`${base}/api/summary`, { headers: { 'x-api-key': body.token } });
    assert.strictEqual(after.status, 401, 'la key revocada deja de servir');
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
      console.error(`     ${error.message}`);
    }
  }

  await queue.drain(2000);

  console.log('');
  console.log(failed ? `${failed} test(s) fallaron` : `todo ok (${tests.length} tests)`);
  process.exit(failed ? 1 : 0);
})();
