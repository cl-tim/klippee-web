FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# Explicit source allowlist: local credentials, printer captures and artifacts
# never enter either image, even if present in the build context.
COPY tsconfig*.json vite.config.ts index.html components.json ./
COPY worker-configuration.d.ts ./
COPY src ./src
COPY worker ./worker
COPY public ./public
COPY plugins/orcaslicer/capture_core.py plugins/orcaslicer/restore_core.py plugins/orcaslicer/klippee_plugin.py plugins/orcaslicer/klippee_plugin.html ./plugins/orcaslicer/
COPY scripts/build-orca-plugin.mjs ./scripts/
COPY wrangler.jsonc Dockerfile.cad ./
RUN npm run build && npm prune --omit=dev --offline --no-audit

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
ENV NODE_ENV=production PORT=8080 KLIPPEE_DATA_DIR=/data
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/client ./dist/client
COPY --from=build --chown=node:node /app/dist/klippee/index.js ./dist/klippee/index.js
COPY --chown=node:node scripts/self-host.mjs ./scripts/self-host.mjs
COPY --chown=node:node migrations ./migrations
COPY LICENSE NOTICE.md package.json ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "scripts/self-host.mjs"]
