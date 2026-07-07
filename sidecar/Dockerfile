# Garmin sidecar for GainPace (S-01).
#
# Single-stage on Debian bookworm-slim (NOT alpine): garmin-connect-client pulls
# in node-libcurl-ja3, a native addon that compiles against glibc + libcurl and
# needs those headers at build time. Alpine's musl would break the native build.
FROM node:20-bookworm-slim

# Build toolchain + libcurl dev headers for the native node-libcurl-ja3 addon.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential python3 pkg-config libcurl4-openssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. No committed lockfile yet (the native
# addon can't build on the dev's Windows host to generate one), so use
# `npm install`; add a lockfile + `npm ci` as a later hardening step.
COPY package.json ./
RUN npm install

# Compile TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
# Cloud Run overrides PORT at runtime; 8080 is the local/default fallback.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
