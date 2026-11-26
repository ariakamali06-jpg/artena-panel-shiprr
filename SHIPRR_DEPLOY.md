# Deploying Artena Panel on Shiprr

Shiprr deploys from a **GitHub/GitLab source repository** with its own build pipeline
(custom Dockerfiles and prebuilt images are not supported). Configure everything below
under **App → Settings → Build & Runtime** in the Shiprr dashboard.

## 1. Push the repository

Push this project (the `artena-panel-shiprr` folder contents) to a GitHub or GitLab
repository, then create an app in the Shiprr dashboard pointing at it.

## 2. Build & Runtime settings

```
root directory:  ./
install command: npm install --include=dev
build command:   npm run build
start command:   npm start
health check:    /health
```

Notes:

- `--include=dev` is required: the build needs `tailwindcss` and the start script runs
  the TypeScript server through `tsx`, both of which live in `devDependencies`.
- `npm install` works without `--legacy-peer-deps` (the esbuild/vite peer conflict is
  fixed in `package.json`).
- The server binds to `0.0.0.0:$PORT` — Shiprr injects `PORT` automatically.
- `/health` returns JSON and is suitable for the HTTP readiness check.

## 3. Environment variables (App → Settings → Environment variables)

Required for production:

```
NODE_ENV=production
PUBLIC_BASE_URL=https://<your-app>.shiprr.dev
SESSION_SECRET=<long random string>
```

Optional (feature-dependent) — see ENVIRONMENT_CONFIGURATION_GUIDE.md:

```
ADMIN_USERNAME=...
ADMIN_PASSWORD=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ADMIN_IDS=...
TELEGRAM_BOT_USERNAME=...
SALES_DEFAULT_PROTOCOL=...
SALES_DEFAULT_PORT=...
TCP_LISTEN_PORT=...
TCP_PUBLIC_HOST=...
TCP_PUBLIC_PORT=...
```

Do **not** set `DATA_DIR` / `RAILWAY_VOLUME_MOUNT_PATH` on Shiprr — the filesystem is
ephemeral (see warning below).

## 4. Resources

Start with the default (1,000 MHz CPU / 512 MB RAM, 1 replica). Increase RAM if you
enable the Telegram bot and many relay connections.

## ⚠️ Persistent state — known limitation

Shiprr replicas have **no persistent disk**: everything under `data/`
(`kestrel_state.json` — services, subscriptions, admins, settings) is **lost on every
redeploy or restart**. For production use you must either:

1. accept re-configuring the panel after each deploy, or
2. migrate the state store to an external database (Postgres/Mongo) or object storage.

Option 2 is a code change and is tracked separately.

## Raw VLESS-TCP relay

Shiprr's edge routing is HTTP(S) only. The raw TCP relay (`TCP_LISTEN_PORT`) needs a
public TCP endpoint that Shiprr does not provide — leave it unset and use the
WS/XHTTP protocols behind HTTPS instead.
