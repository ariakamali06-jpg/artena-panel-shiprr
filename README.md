# Kestrel Control

**Kestrel Control** is a full-stack TypeScript proxy & relay orchestration control panel built with Express, React 19, Tailwind CSS v4, and native Node.js TCP/WebSocket/XHTTP relays.

It provides end-to-end service provisioning, live protocol relaying, subscription delivery portals, outbound proxy chaining & live scanning, multi-node federation, Telegram Stars sales automation, a full Telegram Bot admin interface, a mobile-first Telegram Mini App, and granular Role-Based Access Control (RBAC).

---

## Architecture Overview

```text
├── server.ts                       # Express + Vite (dev) / Static (prod) server, relay bootstrap, graceful shutdown
├── server/
│   ├── types.ts                    # Domain models, protocol presets, 19 RBAC permissions
│   ├── config/envConfig.ts         # Configuration-aware resolver, status matrix, zero-fake-value validation
│   ├── store/stateStore.ts         # Atomic JSON persistence (0600), RBAC & inbound scoping, traffic telemetry
│   ├── engine/
│   │   ├── vless.ts                # Binary VLESS v0 header parser & framing helpers
│   │   ├── rateLimiter.ts          # Async token-bucket bandwidth limiter, quota/expiry/IP/connection guards
│   │   ├── uriBuilder.ts           # Multi-protocol URI builder, Manual Builder, X25519 Reality keypairs, Subscription-Userinfo
│   │   ├── security.ts             # scrypt password hashing, HMAC-SHA256 session tokens, SSRF guards, Telegram WebAppData HMAC
│   │   ├── outboundProxy.ts        # Real SOCKS5 / SOCKS4 / HTTP CONNECT socket tunnel dialer + async proxy scanner
│   │   ├── relays.ts               # Live VLESS-WS (/ws/:uuid), VLESS-TCP (net.Server), XHTTP packet-up/stream-up (/xhttp/*), SSRF-safe /proxy/*
│   │   ├── nodeManager.ts          # Multi-node Bearer federation, brute-force throttle, API forwarding
│   │   └── salesEngine.ts          # Subscription plans, order ledger, customer metrics, config-aware fulfillment
│   ├── telegram/botService.ts      # Telegram Bot API long-polling worker, admin wizards, Stars checkout, alert loop
│   └── routes/api.ts               # Complete REST API, public subscription feeds, Mini App API (/api/tma/:action)
└── src/
    ├── App.tsx                     # Admin Console shell, Light/Dark theme, Mini App & Public Portal routing
    ├── lib/api.ts                  # In-memory Bearer token API client & formatters
    ├── components/                 # AuthScreen (First-Run Owner Claim + Login + Access Request), QrCodeCanvas, Toast
    └── views/                      # Overview, Services, Subscriptions, Proxies, Nodes, Sales, TelegramBot, ReportsAndLive, Admins, Settings, MiniApp, PublicPortal
```

---

## Key Features & Functional Parity

| Area | Implemented Capabilities |
| --- | --- |
| **Live Relay Listeners** | VLESS-WS (`/ws/:uuid`, `/vless/:uuid`), XHTTP `packet-up` (out-of-order reassembly) & `stream-up` (`/xhttp/*`, `/xhttp-siz10/*`), standalone VLESS-TCP (`TCP_LISTEN_PORT`), SSRF-protected HTTP `/proxy/*` |
| **Protocols & Config Builder** | `vless-ws`, `vless-tcp`, `xhttp-packet-up`, `xhttp-stream-up`, `xhttp-stream-one`, `vmess-ws`, `trojan-ws`, plus **Manual Protocol Builder** (VLESS/VMess/Trojan/Shadowsocks + TCP/WS/gRPC/XHTTP + None/TLS/Reality with native X25519 keypair generation) |
| **Service & Client Management** | Quick Auto provision, Multi-Exit Combo bundles, Parent Inbound → Child Clients hierarchy, traffic quotas, expiry dates, concurrent IP & connection limits, token-bucket speed limits, UUID regeneration, usage reset, categories, clean IPs & fragmentation |
| **Subscriptions & Public Portals** | Base64 feeds (`/sub/:uuid`, `/sub-group/:uuidKey`, `/sub-all`) with `Subscription-Userinfo` & `Profile-Title` headers, customizable URI remarks & status info-line, password-protected public client portals (`/subscription/:uuid`, `/p/:uuidKey`) with QR codes |
| **Outbound Proxy Chaining** | Native SOCKS5 (RFC 1928/1929), SOCKS4/4a, and HTTP CONNECT tunnel dialing, TLS probing, scoring/grading engine, async multi-concurrency proxy scanner with live polling, cancel, and one-click import |
| **Multi-Node Federation** | Local node Bearer token generation/rotation/disable, brute-force IP lockout & strict allowlist, remote node health probing, remote inbound sync into local subscription groups, API forwarding (`/api/nodes/:id/fwd/*`) |
| **Sales & Telegram Stars** | Configurable Starter/Pro/Ultra plans, Telegram Stars (`XTR`) invoice checkout, order & customer ledger, config-aware auto-fulfillment (`SALES_DEFAULT_PROTOCOL`, `SALES_DEFAULT_PORT`) with explicit manual override support |
| **Telegram Bot & Mini App** | Full admin command suite (`/start`, `/admin`, `/new`, `/quick`, `/server`, `/online`, `/top`, `/expiring`, `/find`, `/bulk`, `/backup`, `/alerts`, `/seturl`, `/id`), inline wizards, editable message templates, and mobile-first `/miniapp` with Telegram WebAppData HMAC verification |
| **Security & RBAC** | First-run owner claim (no hardcoded passwords), `scrypt` password hashing, HMAC-SHA256 in-memory Bearer sessions, login rate limiting, SSRF private-IP blocking, 19 granular permissions + per-inbound scopes, public sub-admin access request workflow |
| **Configuration Awareness** | Safe startup with empty deployment/network/sales env vars, live **Environment & Configuration Status** table in Settings, zero exposed secrets, detailed `ENVIRONMENT_CONFIGURATION_GUIDE.md` |

---

## Quick Start (Local Development)

1. **Install dependencies:**
   ```bash
   npm install
   ```
2. **Optional environment file:**
   Copy `.env.example` to `.env`. You may leave all seven deferred variables (`SESSION_SECRET`, `PUBLIC_BASE_URL`, `TCP_LISTEN_PORT`, `TCP_PUBLIC_HOST`, `TCP_PUBLIC_PORT`, `SALES_DEFAULT_PROTOCOL`, `SALES_DEFAULT_PORT`) empty during initial development — the server boots cleanly and shows their status in **Config & Settings**.
3. **Start the development server:**
   ```bash
   npm run dev
   ```
4. **Open the panel:**
   Visit `http://localhost:3000` and complete the **First-Run Owner Setup** form to create your administrator account.

### Running Unit Tests

```bash
npm test
```

Runs `node:test` suites covering binary VLESS parsing, URI/Reality keypair generation, `scrypt` + HMAC session signing, SSRF guards, Telegram WebAppData verification, and empty-environment validation.

---

## Production Deployment (Docker & Railway)

The repository includes production-ready `Dockerfile` and `railway.json` manifests.

1. Connect the repository to Railway (or build with `docker build -t kestrel-control .`).
2. Attach a persistent volume (e.g., mounted at `/app/data`) and set `DATA_DIR=/app/data`.
3. Follow **[ENVIRONMENT_CONFIGURATION_GUIDE.md](./ENVIRONMENT_CONFIGURATION_GUIDE.md)** step-by-step to configure `SESSION_SECRET`, `PUBLIC_BASE_URL`, optional raw TCP proxy variables, Telegram Bot credentials, and sales defaults.

---

## Security Highlights

- **No hardcoded credentials:** Owner credentials are claimed interactively on first boot or injected via `ADMIN_USERNAME` / `ADMIN_PASSWORD`.
- **In-memory Bearer tokens:** The SPA never persists admin session tokens in `localStorage` or `sessionStorage`.
- **Zero secret leakage:** Sensitive variables (`SESSION_SECRET`, `TELEGRAM_BOT_TOKEN`, `ADMIN_PASSWORD`, node tokens, proxy passwords) are never echoed in logs, API responses, or the Configuration Status UI.
- **SSRF protection:** `/proxy/*`, outbound proxy URLs, and federated node targets block loopback, link-local, RFC1918, and cloud metadata IP ranges.
