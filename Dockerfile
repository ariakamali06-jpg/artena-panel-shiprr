# Artena Panel (Kestrel Control) — production image
# Runs the TypeScript server with tsx and serves the built SPA from /app/dist.
FROM node:22-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# 1) deps — no npm lockfile in repo, so install with legacy peers and keep
#    dev deps (the runtime entrypoint runs through tsx).
COPY package.json ./
RUN npm install --legacy-peer-deps --include=dev --no-audit --no-fund

# 2) source + build the SPA into ./dist
COPY . .
RUN npm run build

# 3) runtime
ENV PORT=3000
EXPOSE 3000

# persistent state lives in ./data — attach a Railway Volume at /app/data
# (do NOT use a Dockerfile VOLUME instruction: Railway rejects it)

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
