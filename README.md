# Trace by XYB

**Trace by XYB** · monitor de actividad de Discord sobre una **user token** (cuenta propia): gateway en vivo, persistencia en Supabase y un dashboard web para ver todo. Pensado para seguir a un grupo chico de usuarios objetivo dentro de los servidores donde ya está la cuenta.

Es **privado y multiusuario**: cada persona que entra a la web registra su cuenta, pega su propio token de Discord y elige sus objetivos. Nadie ve los eventos de nadie. El panel **no pide Supabase ni keys** — la infraestructura va solo en el entorno del deploy.

## Qué registra

| Evento | Tipo en DB | Qué guarda |
|---|---|---|
| Mensaje enviado | `message` | texto, server, canal, autor, adjuntos, reply |
| Mensaje editado | `message_edit` | **contenido anterior**, contenido nuevo, server, canal |
| Mensaje borrado | `message_delete` | último contenido conocido |
| Entrada a voz | `voice_join` | canal de voz, server |
| Salida de voz | `voice_leave` | canal, server y **cuánto tiempo estuvo** |
| Cambio de canal | `voice_move` | canal anterior, canal nuevo, server |
| Stream / cámara | `voice_stream`, `voice_camera` | estado de transmisión o cámara |
| Conexión / desconexión | `presence` | estado anterior → estado nuevo, actividad (Spotify, juego), **dispositivo** (escritorio, móvil, navegador), server |
| Cambio de perfil | `profile_update` | **nombre, display, avatar y banner** (con URLs antes/después), **apodo** del servidor, origen (`user` / `member`) |

Los mensajes solo se ven en servidores mutuos (es lo único a lo que la cuenta tiene acceso). La presencia llega por el gateway de Discord; en servers muy grandes Discord puede limitar el envío de presencias, en servers chicos/medianos anda completo.

## Stack

- Node 22 / Express
- `discord.js-selfbot-v13` para el gateway con user token
- Supabase (Postgres + API REST) — free tier
- SSE para el feed en vivo (sin websockets extra)
- Railway para el host — free trial / Hobby

```
schema.sql              tablas (accounts, targets, events) + índices + RLS + event_stats + admin_usage + prune_events
src/settings.js         configuración de infraestructura (env + data/settings.json); ya no se edita desde el panel
src/accounts.js         cuentas, scrypt, HWID, token de Discord por cuenta, sesiones y las funciones que usa el admin
src/net.js              fetch con deadline, reintentos y causa real del error
src/config.js           perillas de arranque (puerto, TRACK_ALL, targets semilla)
src/db.js               cliente Supabase perezoso + probe + insert batch
src/targets.js          cache de objetivos por owner (refresh cada 20s, backoff si falla)
src/queue.js            buffer de escritura (40 eventos / 700ms)
src/bot.js              un gateway por cuenta: presencia, mensajes, edits, voz, connect/disconnect
src/server.js           API + auth por cookie + bootstrap + SSE
src/index.js            arranque + shutdown limpio
public/index.html       dashboard (vanilla, sin build)
public/app.css          design system del panel
public/app.js           estado, fetch, SSE y render del panel
scripts/demo.js         demo con datos falsos, sin credenciales
scripts/smoke.js        test end-to-end del pipeline
```

---

## Inicio rápido

```bash
npm install
cp .env.example .env      # pegá SUPABASE_URL + SUPABASE_SERVICE_KEY
npm start
```

Abrí `http://localhost:3000`. La primera pantalla es **Crear cuenta**: usuario (3–32 caracteres: letras, números, `.` `-` `_`) y contraseña (mínimo 8). No pide key. La primera cuenta que se registra en la base queda como `admin`; las siguientes como `user`.

Después el panel abre con una sola tarjeta:

1. **Pegar el token** de la cuenta de Discord que va a mirar → queda validado y conectado.
2. **Fijar el objetivo** → ID del usuario (o elegirlo desde un servidor con el botón *Buscar en un server*).
3. Ver el feed en vivo.

El token se guarda **por cuenta** en la tabla `accounts` (`discord_token`, `discord_user_id`, `discord_username`, `discord_avatar`). Nunca se devuelve al navegador: la API solo informa `hasToken` y la cuenta resuelta.

### Precedencia de configuración

`variable de entorno` > `data/settings.json` (vestigio de instalaciones viejas) > vacío.

Supabase y el secreto de sesión vienen del entorno. En el panel solo se toca lo propio de cada cuenta: token de Discord, contraseña, usuario y dispositivo.

### Cuenta y HWID

Cada cuenta queda **atada al dispositivo** que la creó: el navegador calcula un identificador estable (`localStorage` + huella) y el server guarda solo su sha256. Un login desde otro equipo devuelve *“Esta cuenta está vinculada a otro dispositivo”*.

- Para mover una cuenta de equipo: **Ajustes → Dispositivo → Desvincular** (pide la contraseña) y volver a entrar.
- Si el equipo original ya no existe, en el login está **“Cambié de dispositivo”**: con usuario + contraseña se reata la cuenta al equipo nuevo. Ese proceso cierra las sesiones viejas.
- Cambiar la contraseña o desvincular el HWID sube `session_version`, así que las cookies anteriores dejan de valer. El logout además revoca el token firmado en memoria hasta que expira.

`DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` siguen funcionando como **cuenta legacy del deploy**: entra sin HWID y se migra sola a la tabla `accounts` en el primer login. Su contraseña se cambia en las variables del deploy, no desde el panel.

### Gestión de cuentas (rol admin)

La cuenta con `role = admin` ve un botón **Gestionar cuentas** en el sidebar (las `user` no lo ven, y la API responde 403). Cada tarjeta muestra y permite operar:

| Dato | De dónde sale |
| --- | --- |
| usuario, rol, estado (`active` / `blocked`) | `accounts` |
| cuenta de Discord vinculada y **token enmascarado** (`sofi.d…oken`) | `discord_*` de cada cuenta |
| último ingreso, ip y navegador del ingreso | `last_login_at`, `last_ip`, `user_agent` |
| actividad reciente y aperturas del panel | `last_seen_at`, `boot_count` (lo marca `/api/bootstrap`) |
| logins totales, fecha de alta | `login_count`, `created_at` |
| eventos y objetivos de los últimos 7 días | RPC `admin_usage` (si falta, se calcula en memoria y se marca *aproximado*) |
| dispositivo vinculado | `hwid_label` |

Acciones: **bloquear** (con motivo, reversible), **desbloquear**, **fijar contraseña nueva**, **desvincular equipo**, **subir/bajar de admin** y **borrar** (con confirmación en dos clics).

Dos cosas por diseño:

- La contraseña **no se lee**: en la base hay un hash scrypt con salt por cuenta, así que el admin la reemplaza, no la ve. El reseteo sube `session_version` y cierra las sesiones abiertas de esa persona.
- El token de Discord **no se devuelve completo**: el panel muestra solo el principio y el final, alcanza para reconocerlo. Cualquier operación con el token se hace del lado del server.

Borrar una cuenta también borra sus objetivos y sus eventos y libera su gateway de Discord. Bloquearla corta de inmediato sus sesiones (la cookie deja de validar) y el login responde 403 con el motivo. El admin no puede bloquearse, borrarse a sí mismo, ni dejar el panel sin el último admin.

### Historial de una cuenta

Cada tarjeta tiene **Historial**: abre el listado de eventos de **esa** cuenta (los suyos no se mezclan, la consulta va siempre filtrada por `owner`). Arriba se puede filtrar por tipo (mensajes / voz / presencia / perfil), por rango (24 h, 7 o 30 días) o por texto; el conteo dice cuántos hay y cuántos se cargaron.

Tres formas de borrar, todas con confirmación en dos clics:

- **Borrar selección** — tildás con el checkbox lo que querés tirar (o "Seleccionar lo cargado"). Se manda en lotes de 500 ids.
- **Borrar los N del filtro** — tira todo lo que coincide con el filtro activo, aunque no esté cargado en pantalla.
- **Borrar todo** — vacía el historial completo de esa cuenta.

Un detalle que importa: la selección viaja como lista de ids, pero el server refiltra por `owner`, así que mezclar un id de otra cuenta en la request no borra nada de esa otra cuenta. Los ids inválidos o el lote de más de 500 se rechazan con 400 sin tocar la base. Después de borrar se invalida el resumen 24 h de esa cuenta, se recargan las tarjetas y, si el historial borrado era el propio, también se recarga el feed.

**No hace falta volver a correr `schema.sql`** para esto: la v3 que ya tenés trae `events.id` (`bigserial`) y los índices `events_owner_created_idx` / `events_owner_type_idx`, que son lo que usan estas consultas.

### Aislar el deploy

La web se cierra por registro, no por key: cualquiera que tenga la URL puede crear cuenta, pero cada cuenta solo ve sus propios objetivos y eventos. Quien administra bloquea o borra desde el panel (**Gestionar cuentas**), sin tocar Supabase. Si además querés cerrar la puerta por red, hacelo afuera del app (Railway Private Networking o Basic Auth en un proxy). El server ya no tiene API keys ni key de registro.

## Demo sin credenciales

```bash
npm run demo
```

Abre `http://localhost:3311`, usuario `admin`, contraseña `demo`. Carga 3 objetivos de mentira, eventos de todos los tipos y un mensaje nuevo cada 30s para ver el feed en vivo. También crea dos cuentas para probar la gestión del admin: `sofi` (con token de mentira y actividad) y `tomi` (bloqueada, con motivo). No toca Supabase ni Discord.

## 1. Supabase

1. Crear proyecto en https://supabase.com (free).
2. **SQL Editor → New query** → pegar **todo** `schema.sql` → **Run**. El archivo es idempotente: crea lo que falta y hace backfill de las columnas `owner` sobre datos existentes, así que se puede volver a correr sobre una base vieja. **Si ya venías con la v2, volvé a correrlo**: la v3 agrega `status`, `block_reason`, `login_count`, `boot_count`, `last_seen_at`, `user_agent` y la función `admin_usage`, que necesita el panel de gestión. Después de la v3 no hay nada más que correr: el borrado de historial por cuenta trabaja con `events.id` y los índices por `owner` que ya están en ese archivo.
3. **Project Settings → API** → copiar en `.env`:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key (secret) → `SUPABASE_SERVICE_KEY`

La `service_role` bypassea RLS. No la pongas en el frontend ni en un repo público. La clave pública (`sb_publishable_…` / anon) **no sirve**: RLS está habilitado con cero policies, así que solo el server lee y escribe.

Si el panel dice *"Falta correr schema.sql"*, faltó el paso 2.

> **Venís de una versión anterior:** hay que volver a correr `schema.sql`. Las tablas ganaron la columna `owner` (targets y eventos), la cuenta guarda su token de Discord, existen los RPC `event_stats` y `admin_usage` y `accounts` ganó las columnas de gestión (`status`, `block_reason`, `login_count`, `boot_count`, `last_seen_at`, `user_agent`). Sin ese paso el panel muestra el error de schema en el banner superior en vez de quedar mudo; la gestión de cuentas funciona igual pero marca el uso como *aproximado*.

## 2. Token de Discord

1. Abrir Discord en el navegador, logueado con la cuenta que va a monitorear.
2. DevTools (F12) → **Application → Local Storage → https://discord.com** → campo `token`.
3. Pegarlo en la tarjeta de inicio o en **Ajustes → Token de Discord** → *Guardar y conectar*.

El server valida el token contra `GET /users/@me` antes de guardar y muestra la cuenta resuelta (`tu_cuenta · 123456789012345678`) y la cantidad de servidores. Si está vencido o revocado, lo dice ahí mismo: *“Discord rechazó el token: está vencido, revocado o mal copiado”*. Cada cuenta levanta su propio gateway; desconectar una no toca a las demás.

Es una selfbot: va contra los ToS de Discord y la cuenta puede ser baneada. Usá una cuenta secundaria, nunca la principal.

## 3. Correr local

```bash
npm install
npm start
```

Dashboard: `http://localhost:3000`. Sin Supabase configurado se puede entrar y navegar (cuentas en `data/accounts.json`), pero no se guardan objetivos ni eventos; el panel lo avisa con un banner.

Antes de conectar la cuenta real podés verificar que el pipeline anda:

```bash
npm test
```

## 4. Agregar objetivos

Tres formas:

- **Sidebar → Agregar objetivo**: pegar el ID (snowflake, 17–20 dígitos) y una nota. El nombre se resuelve solo si la cuenta está conectada; si no, queda el ID hasta el primer evento. Se agrega al instante (optimista) y revierte solo si el server rechaza.
- **Sidebar → Buscar en un server**: elegir servidor → buscar por nombre → *Fijar*. Los que ya seguís aparecen como *Siguiendo*.
- **`TARGETS`** en el entorno: IDs separados por coma, visibles para todas las cuentas.

El ID se saca con clic derecho en el usuario → *Copiar ID* (con modo desarrollador activado).

Se guardan en la tabla `targets` con tu `owner`. Solo los usuarios de esa lista generan eventos para tu cuenta, salvo que el deploy ponga `TRACK_ALL=true` (loguea todo el mundo en todos los servidores, ojo con el volumen).

En el panel, click en un objetivo filtra todo el feed por esa persona; click en el avatar de un evento hace lo mismo.

## 5. Deploy en Railway

1. Subir el repo a GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Variables (Service → Variables): `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SESSION_SECRET`. Opcionalmente `DASHBOARD_USERNAME` + `DASHBOARD_PASSWORD` como cuenta legacy de respaldo.
4. Railway inyecta `PORT` solo. `railway.json` ya define `npm start`, healthcheck en `/health` y restart on failure.
5. **Settings → Networking → Generate Domain** para tener URL pública.

No hace falta build step: Nixpacks detecta Node y corre `npm install`.

**Persistencia**: el filesystem de Railway es efímero. Cuentas, tokens, objetivos y eventos viven en Supabase; en `data/` solo queda el `session_secret` autogenerado (y las cuentas locales si no usás Supabase). Por eso conviene definir `SESSION_SECRET`: sin él, cada redeploy firma cookies nuevas y todos se quedan fuera hasta volver a entrar.

### Si algo anda lento o no carga

- **`TypeError: fetch failed`**: todas las llamadas a Supabase llevan deadline de 12s, reintentos de conexión y la causa real (`ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, timeout). El banner y `GET /health` muestran el estado de la base sin entrar al panel.
- Verificá que `SUPABASE_URL` sea la **Project URL** (`https://<ref>.supabase.co`), no `db.<ref>.supabase.co` ni el pooler.
- Verificá que `SUPABASE_SERVICE_KEY` sea la **service_role** (no la publishable/anon). Una key inválida es justamente lo que antes producía `Invalid API key` en cada reintento: hoy el server lo detecta al arrancar y lo reporta como estado de la base, no como error del bot.
- Corré `schema.sql` completo: si falta una tabla o la columna `owner`, el panel lo dice.
- `GET /health` devuelve `db` (con `code` y `message`) y la cantidad de targets cacheados.

---

## Variables de entorno

Todas son opcionales: sin Supabase, el panel arranca igual y avisa que la base no está configurada.

| Variable | Para qué |
|---|---|
| `SUPABASE_URL` | URL del proyecto Supabase (Project URL) |
| `SUPABASE_SERVICE_KEY` | service_role key; el server es el único cliente |
| `SESSION_SECRET` | firma de la cookie; si falta se genera y se guarda en `data/settings.json` |
| `DASHBOARD_USERNAME` | cuenta legacy del deploy (por defecto `admin` si hay `DASHBOARD_PASSWORD`) |
| `DASHBOARD_PASSWORD` | contraseña de la cuenta legacy; entra sin HWID y se migra a la base |
| `PORT` | 3000 por defecto; Railway lo inyecta |
| `TRACK_ALL` | `true` = loguear todos, no solo los targets |
| `TARGETS` | IDs extra separados por coma (se suman para todas las cuentas) |
| `SELF_PRESENCE` | `online`, `idle`, `dnd` o `invisible` para el estado de la propia cuenta |
| `ALERT_WEBHOOK` | webhook de Discord: avisa conexión/desconexión, voz y stream |
| `DATA_DIR` | carpeta de `settings.json` y del fallback local (por defecto `./data`) |

No existe `DISCORD_TOKEN` como variable del server: el token es de cada cuenta y se pega en el panel.

## API

Todo bajo cookie de sesión salvo `/api/login`, `/api/register`, `/api/recover-device`, `/api/session`, `/health`.

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/api/register` | `{ username, password, hwid, hwid_label }` → crear cuenta y cookie (la primera queda `admin`) |
| POST | `/api/login` | `{ username, password, hwid, hwid_label }` → cookie firmada 7 días |
| POST | `/api/recover-device` | `{ username, password, hwid, hwid_label }` → reatar la cuenta a otro dispositivo |
| POST | `/api/logout` | cerrar sesión y revocar el token firmado |
| GET | `/api/session` | `authed`, usuario, rol, cuenta y estado de la base |
| GET | `/api/bootstrap` | **una sola request**: cuenta, bot, objetivos, resumen 24h, últimos eventos, cursor, servidores y estado de la DB |
| GET | `/api/summary` | contadores 24h, presencia, voz, actividad actual y avatares de los objetivos |
| GET | `/api/events` | `type, guild, user, q, limit, offset` — siempre filtrado por owner |
| GET | `/api/stream` | SSE con los eventos nuevos de **tu** cuenta |
| GET | `/api/targets` | listar objetivos propios |
| POST | `/api/targets` | `{ user_id, note }` → upsert idempotente |
| DELETE | `/api/targets/:userId` | quitar un objetivo propio |
| GET | `/api/guilds` | servidores de la cuenta conectada |
| GET | `/api/members` | `guild, q` → buscar miembros |
| GET | `/api/settings` | cuenta, estado del bot y estado de la DB |
| PUT | `/api/settings/token` | `{ token }` → valida, guarda y reconecta el gateway de esa cuenta |
| DELETE | `/api/settings/token` | olvidar el token y apagar el gateway de esa cuenta |
| POST | `/api/bot/reconnect` | reconectar el gateway propio |
| POST | `/api/bot/disconnect` | desconectar el gateway propio |
| PUT | `/api/account` | `{ current, username?, password? }` → cambiar usuario/contraseña (sube `session_version`) |
| DELETE | `/api/account/hwid` | `{ password }` → desvincular el dispositivo y cerrar sesiones |
| GET | `/api/admin/accounts` | **(admin)** todas las cuentas con ip, navegador, uso, token enmascarado y totales |
| POST | `/api/admin/accounts/:user/status` | `{ status: "active"\|"blocked", reason? }` → bloquear o reactivar (cierra sus sesiones) |
| POST | `/api/admin/accounts/:user/password` | `{ password }` → fijar contraseña nueva sin leer la vieja |
| POST | `/api/admin/accounts/:user/role` | `{ role: "admin"\|"user" }` → no deja el panel sin admin |
| POST | `/api/admin/accounts/:user/unlink` | desvincular el dispositivo de esa cuenta |
| DELETE | `/api/admin/accounts/:user` | borrar la cuenta con sus objetivos, eventos y gateway |
| GET | `/api/admin/accounts/:user/history` | historial de esa cuenta, con `type` / `from` / `to` / `q` / `offset` |
| DELETE | `/api/admin/accounts/:user/history` | `{ scope: "all" \| "query" \| "ids", ids?[] , type?, from?, to?, q? }` → borra y devuelve cuántos |
| GET | `/health` | healthcheck para Railway (`db`, `targets`) |
| GET | `/api/health` | ping sin autenticar |

No hay `/api/keys`, `/api/registration-key` ni `/api/settings/test`: se borraron y el server responde 404 (lo cubre el smoke test).

## Notas técnicas

- **Una carga, una request**: el panel arranca con `/api/bootstrap` en vez de seis llamadas encadenadas. El resumen 24h sale de un solo RPC (`event_stats`) y se cachea por owner; los contadores del feed y de la barra lateral se actualizan en local desde el SSE sin volver a pedir.
- **Sin acciones canceladas**: el feed y la búsqueda de miembros usan `AbortController` + secuencia monótona, así una respuesta vieja no pisa una nueva. Es la causa de los “movimientos que se cancelaban”.
- **Escritura optimista**: fijar o quitar un objetivo se refleja al instante y revierte solo si el server rechaza.
- **Batch de escritura**: los eventos se agrupan (40 por lote / 700ms) antes de tocar Supabase. Si la DB falla, el lote se reintenta cada 3s hasta 5 veces; la cola tiene techo de 5000 para no comerse la RAM.
- **Multi-tenant**: `targets` y `events` llevan `owner`; el runtime del bot (cachés de presencia, voz y perfil) es uno por cuenta, y el SSE enruta por owner. Un usuario no puede leer los eventos de otro ni por ID.
- **Transiciones reales**: presencia y voz salen de packets crudos (`PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`), con un Map de estado anterior. La misma conexión llega una vez por cada guild en común y se loguea una sola vez.
- **Edits sin cache**: cuando llega un `messageUpdate` sin contenido viejo, se busca el original en `events` por `message_id` y **solo dentro del owner**. Por eso funciona después de un reinicio del bot. Si el original es anterior al bot, queda `metadata.original_known = false`.
- **Voz con duración**: al salir o moverse se calcula cuánto estuvo en el canal desde el join.
- **Perfil con baseline**: `USER_UPDATE` y `GUILD_MEMBER_UPDATE` llegan sin el estado anterior, así que el bot guarda en memoria el último perfil visto por usuario (y el apodo por servidor). Al conectar siembra ese baseline desde la cache, y en cada packet emite un solo `profile_update` con `metadata.changes`, `before`, `after`, `source` e `initial`. Los avatares/banners animados (`a_…`) se resuelven como `.gif`; sin avatar se usa el default que corresponde al id.
- **Presencia al arranque**: se siembra el estado actual desde la cache de guilds, así el panel muestra quién está online sin esperar a que cambie.
- **Retención**: los eventos no se borran solos. Se puede borrar por cuenta desde **Gestionar cuentas → Historial** (todo, por filtro o una selección) o con `pg_cron`:
  ```sql
  select cron.schedule('prune-events', '0 3 * * *', $$select prune_events(90)$$);
  ```
- **Seguridad del dashboard**: cookie HMAC HttpOnly (+ `Secure` detrás de HTTPS) con `session_version` revocable y revocación en memoria al logout, contraseñas con scrypt + salt, HWID como sha256, rate limit de intentos fallidos (12/min por IP), `robots.txt` con `Disallow: /`, token de Discord y hashes fuera de toda respuesta de la API.
- **Gestión sin secretos visibles**: el panel de admin arma su vista con `publicView()`, que nunca incluye `password_hash`, `password_salt`, `hwid_hash` ni el token completo (solo `token_preview`). Bloquear, resetear contraseña o desvincular suben `session_version`, así que la persona pierde las sesiones abiertas en el acto; borrar libera el gateway y limpia `targets`/`events` de esa cuenta. El `user_agent` se guarda recortado a 240 caracteres desde la request, no de un tracker.
- **Historial con dueño**: la lectura y el borrado del historial arman la consulta con `.eq('owner', cuenta)` antes de cualquier filtro, inclusive en `scope: "ids"`. Un id de otra cuenta que se cole en la selección no se borra; y el `.select('id')` del borrado devuelve la fila exacta que salió, así el contador que ve el admin es real y no una estimación.
- **Red resiliente**: `src/net.js` pone deadline de 12s y reintenta solo conexiones que todavía no se establecieron (no duplica escrituras). `targets.refresh` entra en backoff de 30s tras un fallo y el panel muestra el error real en vez de quedar mudo.
- **Webhook opcional**: `ALERT_WEBHOOK` manda un mensaje a un webhook de Discord en cada conexión/desconexión, entrada/salida de voz y stream.
