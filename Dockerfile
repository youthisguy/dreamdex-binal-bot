# DreamDEX bot worker — deploy via Railway template (see docs/railway.md).
FROM node:20-bookworm-slim

WORKDIR /app

# ca-certificates: TLS trust store for outbound HTTPS calls (Telegram, RPC, etc).
# Font rendering no longer depends on OS packages — the signal stat-card SVG
# embeds IBM Plex Mono/Sans directly as base64 @font-face data (see
# packages/.../embedded-fonts.ts), so no fontconfig/fonts-ibm-plex install
# (and no dependency on Debian's contrib component) is needed here.
RUN apt-get update \
&& apt-get install -y --no-install-recommends ca-certificates fontconfig \
&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY strategies strategies
COPY advanced advanced
COPY scripts scripts
COPY dashboard dashboard
COPY assets assets
COPY .env.railway .env

RUN npm ci

ENV NODE_ENV=production

CMD ["node", "scripts/railway-start.mjs"]