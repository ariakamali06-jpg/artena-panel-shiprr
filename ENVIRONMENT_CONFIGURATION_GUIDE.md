# Environment Configuration Guide

This guide documents every environment variable read by **Artena Panel**, how the application behaves when variables are intentionally left empty, and the exact steps to configure both local development and production deployments (including Railway).

---

## Configuration Architecture & Categories

Artena Panel validates all runtime environment variables through `server/config/envConfig.ts` on startup and exposes a live, secret-safe **Configuration Status** table inside the Admin Panel (**Config & Settings → Environment & Configuration Status** and `GET /api/config/status`).

Every variable belongs to one of six operational categories:

| Category | Meaning |
| --- | --- |
| `required` | Strongly required for production security and deterministic sessions. Uses safe ephemeral fallback only in initial setup. |
| `optional` | Has safe built-in defaults or can be managed through the Admin UI. |
| `deployment-dependent` | Depends on the final HTTPS domain assigned by your reverse proxy, VPS, or Railway service. |
| `network-dependent` | Depends on raw TCP socket port exposure and external TCP proxy mapping (e.g., Railway TCP Proxy or VPS firewall). |
| `telegram-dependent` | Required only when operating the Telegram Bot admin interface, Telegram Stars checkout, or Telegram Mini App WebAppData authentication. |
| `sales-dependent` | Required for automated sales order provisioning when no per-order protocol/port override is provided. |

> **Zero Fabricated Values Policy:** Artena Panel never invents fake domains, placeholder Railway hosts, or arbitrary TCP/sales ports when the seven deferred environment variables below are empty. Features that depend on an empty variable remain gracefully paused and return actionable configuration guidance until you supply real values.

---

## The Seven Deferred Configuration Variables

These seven variables are intentionally empty in `.env.example` so the application boots cleanly before your domain, TCP proxy, and sales preferences are finalized.

---

### 1. `SESSION_SECRET`

- **Category:** `required` (Production) / `fallback` (Initial dev startup)
- **What it is:** A high-entropy cryptographic key used to HMAC-SHA256 sign all admin Bearer session tokens.
- **Why the application needs it:** Prevents session token forgery and ensures signing material is consistent and cryptographically strong.
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`) → consumed by `server/engine/security.ts` (`SessionManager.create` and `SessionManager.verifySignature`).
- **Expected format:** UTF-8 string, minimum **32 characters** (64-character hex string recommended).
- **Required at startup?** No — if left empty, Artena Panel generates a single ephemeral 32-byte random key in memory (`EPHEMERAL_SESSION_SECRET`) so the panel boots cleanly without crashing.
- **Behavior when empty:**
  - Startup log records `[FALLBACK] SESSION_SECRET`.
  - Admin login works normally, but any active sessions are invalidated whenever the server restarts.
  - The Configuration Status UI marks `SESSION_SECRET` as **Fallback**.
- **How to generate a production value:**
  ```bash
  openssl rand -hex 32
  ```
  Or with Node.js:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **Where to add it:** Local `.env` file or Railway Service **Variables** tab.
- **Security notes:** Never commit `SESSION_SECRET` to Git, never reuse passwords as `SESSION_SECRET`, and never log or expose it in client bundles.

---

### 2. `PUBLIC_BASE_URL`

- **Category:** `deployment-dependent`
- **What it is:** The canonical public HTTPS origin (scheme + domain, no trailing slash) where Artena Panel is reachable by end users and Telegram servers.
- **Why the application needs it:**
  - Registers the Telegram Bot's Mini App menu button (`setChatMenuButton` → `<PUBLIC_BASE_URL>/miniapp`).
  - Generates canonical subscription feed URLs (`/sub/:uuid`, `/sub-group/:uuidKey`) and client portal links (`/subscription/:uuid`, `/p/:uuidKey`) sent via Telegram Bot messages and API responses.
  - Provides the default hostname embedded into generated VLESS-WS, XHTTP, VMess-WS, and Trojan-WS URIs.
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`), `server/routes/api.ts` (`getPublicHostAndBase`), `server/telegram/botService.ts` (`getBaseUrl`, `syncMenuButton`).
- **Expected format:** Valid `http://` or `https://` origin without path or trailing slash. Telegram Mini App integration strictly requires `https://`.
- **Required at startup?** No.
- **Behavior when empty:**
  - The Admin Panel UI and HTTP/WS/XHTTP APIs continue working normally.
  - Web UI requests fall back to inspecting incoming `X-Forwarded-Host` / `Host` headers only for browser-side preview links, while explicitly flagging `publicBaseConfigured: false`.
  - Telegram Bot refuses to register a fake Mini App URL and notifies admins to configure `PUBLIC_BASE_URL` (or run `/seturl https://your-domain.tld`).
- **Local Development vs Railway Deployment:**
  - **Local Development:** Leave empty while testing locally on port `3000`, or set it to a temporary HTTPS tunnel origin (e.g., Cloudflare Tunnel or ngrok) if testing the Telegram Mini App locally.
  - **Railway Deployment:**
    1. Deploy the service on Railway.
    2. Open **Service → Settings → Networking → Public Networking → Generate Domain** (or attach your custom domain).
    3. Copy the resulting HTTPS URL (for example `https://your-service.up.railway.app`) and set `PUBLIC_BASE_URL` in **Service → Variables** (or update it in **Config & Settings** inside the Admin Panel).

---

### 3. `TCP_LISTEN_PORT`

- **Category:** `network-dependent`
- **What it is:** The internal container/host TCP port on which Artena Panel binds its standalone raw **VLESS-TCP** socket listener (`net.createServer`).
- **Why the application needs it:** Raw VLESS-TCP operates directly over a raw TCP socket rather than HTTP/WebSocket upgrade, so it requires its own dedicated listening port separate from the HTTP/Express port (`PORT`).
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`), `server/engine/relays.ts` (`startTcpRelay`, `getTcpRelayStatus`), `server.ts`.
- **Expected format:** Integer between `1` and `65535` (must not collide with `PORT`).
- **Required at startup?** No.
- **Behavior when empty:**
  - The raw VLESS-TCP relay listener stays safely **paused** (`tcpRelay.configured = false`, `tcpRelay.active = false`).
  - No fake port is opened and no startup crash occurs.
  - VLESS-WS (`/ws/:uuid`) and XHTTP (`/xhttp/*`) continue running normally on the primary HTTP server.
  - Overview & Configuration Status clearly display `Pending TCP_LISTEN_PORT`.
- **Local Development vs Railway Deployment:**
  - **Local Development:** Leave empty unless testing raw VLESS-TCP locally; if testing locally, pick any unused port (e.g., an open high port like `6543`) and set `TCP_LISTEN_PORT`.
  - **Railway Deployment:**
    1. Choose an internal container port for raw TCP (different from Railway's HTTP `PORT`).
    2. Set `TCP_LISTEN_PORT` in Railway **Variables**.
    3. Open **Service → Settings → Networking → TCP Proxy**, enter the exact same internal port number, and enable the TCP Proxy.
    4. Railway will assign an external hostname and port (e.g., `monorail.proxy.rlwy.net:12345`), which you then place into `TCP_PUBLIC_HOST` and `TCP_PUBLIC_PORT`.

---

### 4. `TCP_PUBLIC_HOST`

- **Category:** `network-dependent`
- **What it is:** The external hostname or public IP address that VPN clients dial when connecting to a `vless-tcp` service.
- **Why the application needs it:** Behind NAT, Docker, or Railway TCP Proxy, the external hostname for raw TCP traffic is often completely different from the HTTP domain (`PUBLIC_BASE_URL`).
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`), `server/routes/api.ts` (`enrichService`, `/sub/:uuid`), `server/engine/uriBuilder.ts` (`buildServiceUri`).
- **Expected format:** Public DNS hostname or IPv4/IPv6 address (no scheme, no port, no path).
- **Required at startup?** No. Only required when generating connectable `vless-tcp` client URIs or subscription feeds.
- **Behavior when empty:**
  - Services using `vless-ws`, `xhttp-*`, `vmess-ws`, or `trojan-ws` are completely unaffected.
  - Any `vless-tcp` service displays an explicit configuration warning (`Missing: TCP_PUBLIC_HOST`) instead of generating a broken URI, and `/sub/:uuid` returns HTTP `409` with clear setup instructions.
- **Local Development vs Railway Deployment:**
  - **Local Development:** Leave empty unless testing raw TCP; on a LAN/local test, use your machine's reachable IP.
  - **Railway Deployment:** Copy the **hostname** portion of the Railway TCP Proxy endpoint (everything before the colon `:`) and set `TCP_PUBLIC_HOST`. On a dedicated VPS, use your server's public IP or A-record domain.

---

### 5. `TCP_PUBLIC_PORT`

- **Category:** `network-dependent`
- **What it is:** The external TCP port number that VPN clients connect to on `TCP_PUBLIC_HOST`.
- **Why the application needs it:** Cloud TCP proxies (such as Railway TCP Proxy) map an arbitrary external port (e.g., `34182`) to your container's internal `TCP_LISTEN_PORT`. Clients must dial the external port.
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`), `server/routes/api.ts` (`enrichService`, `/sub/:uuid`), `server/engine/uriBuilder.ts` (`buildServiceUri`).
- **Expected format:** Integer between `1` and `65535`.
- **Required at startup?** No. Only required alongside `TCP_PUBLIC_HOST` for `vless-tcp` URIs.
- **Behavior when empty:**
  - Same graceful protection as `TCP_PUBLIC_HOST`: no fake port is invented, and `vless-tcp` URI generation clearly reports `Missing: TCP_PUBLIC_PORT`.
- **Local Development vs Railway Deployment:**
  - **Local Development:** Match `TCP_LISTEN_PORT` if testing directly on the same host.
  - **Railway Deployment:** Copy the **port** portion assigned by Railway's TCP Proxy (everything after the colon `:`). On a VPS with direct firewall exposure, match `TCP_LISTEN_PORT`.

---

### 6. `SALES_DEFAULT_PROTOCOL`

- **Category:** `sales-dependent`
- **What it is:** The default protocol preset automatically provisioned whenever a customer completes a Telegram Stars (`XTR`) purchase or an administrator triggers sales fulfillment without specifying a protocol override.
- **Why the application needs it:** Ensures automated sales orders provision the exact transport you have deployed and tested (HTTP/TLS-fronted WS/XHTTP vs raw TCP) instead of silently picking an unsupported protocol.
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`, `ACCEPTED_SALES_PROTOCOLS`), `server/engine/salesEngine.ts` (`fulfillOrder`).
- **Accepted values (exact identifiers from `server/types.ts`):**
  - `vless-ws` — Live VLESS over WebSocket (`/ws/:uuid`)
  - `vless-tcp` — Live VLESS over raw TCP (requires `TCP_LISTEN_PORT`, `TCP_PUBLIC_HOST`, `TCP_PUBLIC_PORT`)
  - `xhttp-packet-up` — Live XHTTP Packet-Up (`/xhttp/packet-up/:uuid/:sessionId`)
  - `xhttp-stream-up` — Live XHTTP Stream-Up (`/xhttp/stream-up/:uuid/:sessionId`)
  - `xhttp-stream-one` — XHTTP Stream-One configuration preset
  - `vmess-ws` — VMess over WebSocket configuration preset
  - `trojan-ws` — Trojan over WebSocket configuration preset
- **Required at startup?** No.
- **Behavior when empty or invalid:**
  - Panel starts normally; you can still create/edit plans and view ledgers.
  - Automated Telegram Stars fulfillment and manual fulfillment without a protocol override return a clear error stating `Missing: SALES_DEFAULT_PROTOCOL` and listing the accepted values.
  - Manual fulfillment in **Plans & Sales → Fulfill Order** still works immediately if you select an explicit **Protocol Override** and **Port Override**.

---

### 7. `SALES_DEFAULT_PORT`

- **Category:** `sales-dependent`
- **What it is:** The default client-facing port embedded into services provisioned by the automated sales engine when no per-order port override is supplied.
- **Why the application needs it:** Different deployments terminate TLS or TCP on different external ports (e.g., `443` behind Railway/Cloudflare HTTPS reverse proxy, or your external `TCP_PUBLIC_PORT` when selling `vless-tcp`).
- **Where it is read:** `server/config/envConfig.ts` (`resolveRuntimeConfig`), `server/engine/salesEngine.ts` (`fulfillOrder`).
- **Expected format:** Integer between `1` and `65535`.
- **Required at startup?** No.
- **Behavior when empty:**
  - Automated sales fulfillment refuses to guess a port and returns an actionable error (`Missing: SALES_DEFAULT_PORT`).
  - Manual fulfillment works whenever an explicit **Port Override** is supplied.
- **How to choose the right value:**
  - If `SALES_DEFAULT_PROTOCOL` is `vless-ws`, `xhttp-packet-up`, `xhttp-stream-up`, `xhttp-stream-one`, `vmess-ws`, or `trojan-ws` behind an HTTPS reverse proxy (Railway / Nginx / Caddy / Cloudflare): use the public TLS port (`443`).
  - If `SALES_DEFAULT_PROTOCOL` is `vless-tcp`: use the same external port as `TCP_PUBLIC_PORT`.

---

## Supporting Environment Variables

| Variable | Category | Default | Purpose |
| --- | --- | --- | --- |
| `PORT` | `optional` | `3000` | HTTP server port for Express API, Web UI, VLESS-WS (`/ws/:uuid`), and XHTTP (`/xhttp/*`). Railway injects `PORT` automatically at runtime. |
| `NODE_ENV` | `optional` | `development` | Set to `production` in Docker/Railway builds to serve the compiled Vite frontend from `dist/`. |
| `DATA_DIR` | `optional` | `./data` | Directory where atomic JSON state files (`kestrel_state.json`, `nodes.json`, `proxies.json`, `sales.json`) are persisted. Mount a persistent Railway Volume here in production. |
| `ADMIN_USERNAME` | `optional` | *(First-run UI setup)* | Optional environment override for the Owner account username. When omitted, the first visitor claims the Owner account securely via the Setup screen. |
| `ADMIN_PASSWORD` | `optional` | *(First-run UI setup)* | Optional environment override for the Owner password. When set, overrides stored password hash and disables UI password changes. |
| `TELEGRAM_BOT_TOKEN` | `telegram-dependent` | *(empty)* | Bot token issued by `@BotFather`. Enables the Telegram Bot worker, Stars checkout, and Mini App HMAC-SHA256 `initData` validation. Can also be configured inside **Telegram Bot** in the UI. |
| `TELEGRAM_ADMIN_IDS` | `telegram-dependent` | *(empty)* | Comma-separated numeric Telegram user IDs authorized to execute admin bot commands and access `/miniapp` via Telegram. Send `/id` to your bot to obtain your numeric ID. |

---

## Recommended Configuration Order & Dependencies

Follow this sequence when deploying Artena Panel to production (e.g., Railway):

1. **Generate & set `SESSION_SECRET`**
   - *Depends on:* Nothing.
   - *Action:* Run `openssl rand -hex 32` and add `SESSION_SECRET` to your environment variables before your first production login.
2. **Mount persistent storage (`DATA_DIR`)**
   - *Depends on:* Railway Volume (recommended mount path `/app/data`, set `DATA_DIR=/app/data`).
   - *Action:* Ensures services, subscriptions, sub-admins, nodes, proxies, and sales ledgers survive container redeploys.
3. **Deploy HTTP service & obtain `PUBLIC_BASE_URL`**
   - *Depends on:* Deployment completing and public HTTPS domain being assigned.
   - *Action:* Generate a Railway domain or bind your custom domain, then set `PUBLIC_BASE_URL=https://your-domain.tld`.
4. **Configure Telegram integration (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`)**
   - *Depends on:* `PUBLIC_BASE_URL` (for the Mini App button and public portal links).
   - *Action:* Create a bot in `@BotFather`, add `TELEGRAM_BOT_TOKEN`, start the bot, message `/id`, and add your numeric ID to `TELEGRAM_ADMIN_IDS`.
5. **(Optional) Enable Raw VLESS-TCP (`TCP_LISTEN_PORT`, `TCP_PUBLIC_HOST`, `TCP_PUBLIC_PORT`)**
   - *Depends on:* Host firewall or Railway TCP Proxy.
   - *Action:* Set `TCP_LISTEN_PORT`, enable Railway TCP Proxy targeting that exact port, then copy the generated host and port into `TCP_PUBLIC_HOST` and `TCP_PUBLIC_PORT`.
6. **(Optional) Enable Automated Sales Fulfillment (`SALES_DEFAULT_PROTOCOL`, `SALES_DEFAULT_PORT`)**
   - *Depends on:* Step 3 (for WS/XHTTP protocols) or Step 5 (for `vless-tcp`), plus Step 4 (for Telegram Stars checkout).
   - *Action:* Set `SALES_DEFAULT_PROTOCOL` to a validated protocol identifier and `SALES_DEFAULT_PORT` to the matching external port.

---

## Final Pre-Production Checklist

- [ ] `SESSION_SECRET` generated with 32+ bytes of cryptographic entropy (`openssl rand -hex 32`)
- [ ] Persistent storage volume attached and `DATA_DIR` pointed to the mounted volume
- [ ] Owner account claimed via First-Run Setup (or locked via `ADMIN_USERNAME` + `ADMIN_PASSWORD`)
- [ ] `PUBLIC_BASE_URL` set to the live HTTPS origin (verified in **Config & Settings**)
- [ ] If using raw VLESS-TCP: `TCP_LISTEN_PORT`, `TCP_PUBLIC_HOST`, and `TCP_PUBLIC_PORT` all configured and verified as **Listening** in Overview
- [ ] If using Telegram Bot & Mini App: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_IDS` set, bot worker running, and `/miniapp` opens over HTTPS
- [ ] If selling plans via Telegram Stars: `SALES_DEFAULT_PROTOCOL` and `SALES_DEFAULT_PORT` set and verified in **Config & Settings**
- [ ] All entries in **Config & Settings → Environment & Configuration Status** show **Configured** (no **Invalid** states)
