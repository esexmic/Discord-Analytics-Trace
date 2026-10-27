'use strict';

/**
 * Demo local con datos falsos: no toca Supabase ni Discord.
 *
 *   npm run demo        ->  http://localhost:3311  (admin / demo)
 */

const os = require('os');
const path = require('path');

process.env.DATA_DIR = path.join(os.tmpdir(), `XYB-demo-${process.pid}`);
process.env.DISCORD_TOKEN = 'demo.token.value.demo.token.value.demo';
process.env.SUPABASE_URL = 'https://demo.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'demo-service-key';
process.env.DASHBOARD_USERNAME = 'admin';
process.env.DASHBOARD_PASSWORD = 'demo';
process.env.SESSION_SECRET = 'demo-session-secret';
process.env.TRACK_ALL = 'true';
process.env.PORT = process.env.DEMO_PORT || '3311';

const { createFakeSupabase } = require('./fake-supabase');

const db = require('../src/db');
const store = new Map();
store.set('events', []);
store.set('targets', []);
store.set('accounts', []);

let nextId = 1;
db.insertEvents = async (rows) => {
  const stored = rows.map((row) => ({ ...row, id: nextId++ }));
  store.get('events').push(...stored);
  return stored;
};
db.__setClient(createFakeSupabase(store));

const bot = require('../src/bot');
const targets = require('../src/targets');
const accounts = require('../src/accounts');
const { startServer } = require('../src/server');

const OWNER = 'admin';
const SELF_ID = '999999999999999999';
const VALEN = '111111111111111111';
const SOFI = '222222222222222222';
const TOMI = '333333333333333333';

const guildA = {
  id: '800000000000000001',
  name: 'Casa de Valen',
  channels: { cache: new Map([['700000000000000001', { id: '700000000000000001', name: 'general' }], ['700000000000000002', { id: '700000000000000002', name: 'Sala de espera' }]]) },
  members: { cache: new Map() },
  presences: { cache: new Map() },
  voiceStates: { cache: new Map() },
};

const guildB = {
  id: '800000000000000002',
  name: 'Los Pibes',
  channels: { cache: new Map([['700000000000000003', { id: '700000000000000003', name: 'memes' }]]) },
  members: { cache: new Map() },
  presences: { cache: new Map() },
  voiceStates: { cache: new Map() },
};

const users = {
  [VALEN]: { id: VALEN, username: 'valen', globalName: 'Valen', discriminator: '0' },
  [SOFI]: { id: SOFI, username: 'sofi', globalName: 'Sofi', discriminator: '0' },
  [TOMI]: { id: TOMI, username: 'tomi', globalName: 'Tomi', discriminator: '0' },
};

for (const [userId, user] of Object.entries(users)) {
  guildA.members.cache.set(userId, { id: userId, user, displayName: user.globalName });
}

guildA.presences.cache.set(VALEN, {
  userId: VALEN,
  status: 'online',
  activities: [{ type: 2, name: 'Spotify', details: 'Bad Bunny', state: 'Tití Me Preguntó' }],
  clientStatus: { desktop: 'online', mobile: 'online' },
});
guildA.presences.cache.set(SOFI, {
  userId: SOFI,
  status: 'dnd',
  activities: [{ type: 0, name: 'Visual Studio Code', details: 'editando XYB' }],
  clientStatus: { desktop: 'online' },
});
guildA.voiceStates.cache.set(VALEN, {
  id: VALEN,
  channelId: '700000000000000002',
  streaming: true,
  selfVideo: false,
});

const fakeClient = {
  user: { id: SELF_ID, username: 'watcher' },
  isReady: () => true,
  guilds: { cache: new Map([[guildA.id, guildA], [guildB.id, guildB]]) },
  users: { cache: new Map(Object.entries(users)), fetch: async (id) => users[id] ?? null },
};

bot.__setClient(OWNER, fakeClient);
const demoRuntime = bot.__runtime(OWNER);
demoRuntime.seedPresence();
demoRuntime.seedVoice();
demoRuntime.seedProfiles();

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();

const name = (id) => users[id].globalName;

const demoBanner = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#5865f2"/><stop offset="1" stop-color="#a970ff"/>' +
  '</linearGradient></defs><rect width="600" height="200" fill="url(#g)"/></svg>'
);

const seed = [
  {
    event_type: 'profile_update',
    user_id: VALEN,
    username: 'Valen',
    guild_id: null,
    guild_name: null,
    content: 'nombre: valen → valen.rp · avatar actualizado · banner actualizado',
    metadata: {
      source: 'user',
      initial: false,
      changes: {
        username: { from: 'valen', to: 'valen.rp' },
        avatar: { from: null, to: 'demo' },
        banner: { from: null, to: 'demo' },
      },
      nick: null,
      before: {
        username: 'valen', global_name: 'Valen', display: 'Valen',
        avatar_url: bot.avatarUrl(VALEN, null), banner_url: null, accent_color: null,
      },
      after: {
        username: 'valen.rp', global_name: 'Valen', display: 'Valen',
        avatar_url: 'https://cdn.discordapp.com/embed/avatars/2.png',
        banner_url: demoBanner,
        accent_color: null,
      },
    },
    created_at: ago(4),
  },
  {
    event_type: 'presence',
    user_id: VALEN,
    username: name(VALEN),
    guild_id: guildA.id,
    guild_name: guildA.name,
    metadata: {
      from: 'offline',
      to: 'online',
      devices: ['desktop', 'mobile'],
      activities: [{ type: 2, name: 'Spotify', details: 'Bad Bunny', state: 'Tití Me Preguntó' }],
    },
    created_at: ago(6),
  },
  {
    event_type: 'voice_join',
    user_id: VALEN,
    username: name(VALEN),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000002',
    channel_name: 'Sala de espera',
    metadata: { from: null, to: '700000000000000002' },
    created_at: ago(8),
  },
  {
    event_type: 'message',
    message_id: '555555555555550001',
    user_id: SOFI,
    username: name(SOFI),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000001',
    channel_name: 'general',
    content: 'estamos todos en el canal, vení cuando puedas',
    metadata: { attachments: 0, mentions: 1, reply_to: null },
    created_at: ago(11),
  },
  {
    event_type: 'message_edit',
    message_id: '555555555555550002',
    user_id: VALEN,
    username: name(VALEN),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000001',
    channel_name: 'general',
    old_content: 'voy en 5',
    content: 'voy en 5, en serio esta vez',
    metadata: { original_known: true, attachments: 0 },
    created_at: ago(14),
  },
  {
    event_type: 'message_delete',
    message_id: '555555555555550003',
    user_id: TOMI,
    username: name(TOMI),
    guild_id: guildB.id,
    guild_name: guildB.name,
    channel_id: '700000000000000003',
    channel_name: 'memes',
    content: 'jaja no era para vos',
    metadata: {},
    created_at: ago(20),
  },
  {
    event_type: 'voice_leave',
    user_id: SOFI,
    username: name(SOFI),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000002',
    channel_name: 'Sala de espera',
    metadata: { from: '700000000000000002', to: null, seconds: 1830 },
    created_at: ago(26),
  },
  {
    event_type: 'presence',
    user_id: SOFI,
    username: name(SOFI),
    guild_id: guildA.id,
    guild_name: guildA.name,
    metadata: { from: 'idle', to: 'dnd', devices: ['desktop'], activities: [{ type: 0, name: 'Visual Studio Code' }] },
    created_at: ago(33),
  },
  {
    event_type: 'voice_move',
    user_id: SOFI,
    username: name(SOFI),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000002',
    channel_name: 'Sala de espera',
    metadata: { from: '700000000000000001', to: '700000000000000002', from_name: 'general', seconds: 240 },
    created_at: ago(41),
  },
  {
    event_type: 'message',
    message_id: '555555555555550004',
    user_id: VALEN,
    username: name(VALEN),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000001',
    channel_name: 'general',
    content: 'llegué, abrime',
    metadata: { attachments: 0, mentions: 1, reply_to: null },
    created_at: ago(58),
  },
  {
    event_type: 'presence',
    user_id: SOFI,
    username: name(SOFI),
    guild_id: guildA.id,
    guild_name: guildA.name,
    metadata: { from: 'online', to: 'offline', devices: [], activities: [] },
    created_at: ago(120),
  },
  {
    event_type: 'message',
    message_id: '555555555555550005',
    user_id: TOMI,
    username: name(TOMI),
    guild_id: guildB.id,
    guild_name: guildB.name,
    channel_id: '700000000000000003',
    channel_name: 'memes',
    content: 'miren el clip que mandó valen jajaja',
    metadata: { attachments: 1, mentions: 0, reply_to: null },
    created_at: ago(180),
  },
  {
    event_type: 'voice_join',
    user_id: SOFI,
    username: name(SOFI),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000001',
    channel_name: 'general',
    metadata: { from: null, to: '700000000000000001' },
    created_at: ago(245),
  },
];

store.get('targets').push(
  { owner: OWNER, user_id: VALEN, username: 'Valen', note: 'mi novia', created_at: ago(4000) },
  { owner: OWNER, user_id: SOFI, username: 'Sofi', note: 'la ex', created_at: ago(3000) },
  { owner: OWNER, user_id: TOMI, username: 'Tomi', note: 'hermano', created_at: ago(2000) }
);

for (const row of seed) row.owner = OWNER;

const DEMO_HWID = 'd'.repeat(64);
const DEMO_HWID_B = 'e'.repeat(64);

/** Dos cuentas más, para ver la gestión del admin con datos reales de uso. */
async function seedAccounts() {
  await accounts.register({
    username: 'sofi',
    password: 'demo-sofi-123',
    hwid: DEMO_HWID,
    hwidLabel: 'Windows · Chrome',
    ip: '190.102.33.7',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  });
  await accounts.saveDiscord('sofi', {
    token: 'sofi.demo.token.secreto.sofi.demo.token',
    userId: SOFI,
    username: 'sofi',
    avatar: null,
  });
  await accounts.register({
    username: 'tomi',
    password: 'demo-tomi-123',
    hwid: DEMO_HWID_B,
    hwidLabel: 'Android · Chrome',
    ip: '181.43.9.212',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36',
  });
  await accounts.setStatus('tomi', 'blocked', 'compartió la cuenta con dos más');

  await targets.add('sofi', VALEN, 'Valen', null);
  await targets.add('sofi', TOMI, 'Tomi', 'ex amigo');

  store.get('events').push(
    {
      owner: 'sofi', event_type: 'message', user_id: VALEN, username: 'Valen',
      guild_id: guildA.id, guild_name: guildA.name, channel_id: '700000000000000001',
      channel_name: 'general', content: 'che, viste lo que mandó tomi',
      metadata: { attachments: 0, mentions: 0, reply_to: null }, created_at: ago(18), id: nextId++,
    },
    {
      owner: 'sofi', event_type: 'presence', user_id: VALEN, username: 'Valen',
      guild_id: guildA.id, guild_name: guildA.name,
      metadata: { from: 'idle', to: 'online', devices: ['desktop'], activities: [] }, created_at: ago(52), id: nextId++,
    }
  );
}

db.insertEvents(seed).then(() => seedAccounts()).then(() => {
  const port = Number(process.env.PORT);
  startServer(port);
  console.log(`[demo] datos falsos cargados: ${seed.length} eventos, 3 objetivos, 2 cuentas de gestión`);
  console.log(`[demo] http://localhost:${port}  ·  usuario: admin  ·  contraseña: demo`);
  console.log('[demo] cuentas de ejemplo: sofi / demo-sofi-123 · tomi (bloqueada) / demo-tomi-123');
});

/* Un evento nuevo cada 30s para ver el feed en vivo (SSE) funcionando. */
const queue = require('../src/queue');
const liveTexts = ['ya estoy yendo', 'abrime', 'estoy en la puerta', 'dale que llegué'];
let tick = 0;

setInterval(() => {
  const text = liveTexts[tick % liveTexts.length];
  tick += 1;
  queue.push({
    owner: OWNER,
    event_type: 'message',
    message_id: `demo-${Date.now()}`,
    user_id: VALEN,
    username: name(VALEN),
    guild_id: guildA.id,
    guild_name: guildA.name,
    channel_id: '700000000000000001',
    channel_name: 'general',
    content: text,
    metadata: { attachments: 0, mentions: 0, reply_to: null },
    created_at: new Date().toISOString(),
  });
}, 30_000).unref?.();
