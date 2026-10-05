# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ git make poppler-utils python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.base.json ./
COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/domain packages/domain
COPY docs docs
COPY scripts scripts
RUN npm run build
RUN node -e "const fs=require('node:fs'); const files=fs.readdirSync('apps/server/dist'); if(files.some((name)=>name.startsWith('demo-seed-service-') || name.startsWith('seed-development'))) process.exit(1)"

FROM build AS development-build

RUN UCM_BUILD_MODE=development VITE_DEVELOPMENT_ACCOUNT=true npm run build

FROM build AS production-dependencies

RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="UCM Costing" \
      org.opencontainers.image.description="Formula SAE-A costing and report preparation application"

ENV NODE_ENV=production \
    PORT=8080 \
    UCM_DATA_ROOT=/app/data \
    UCM_OUTPUT_ROOT=/app/output \
    UCM_BACKUP_ROOT=/app/backups \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils postgresql-client-15 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/apps/server/package.json apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /app/apps/server/assets apps/server/assets
COPY --from=build --chown=node:node /app/apps/web/dist apps/web/dist
COPY --from=production-dependencies --chown=node:node /app/node_modules node_modules
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node LICENSES LICENSES
COPY --chown=node:node scripts scripts
COPY --chown=node:node docs/references/official docs/references/official
COPY --chown=node:node ["docs/Local Addendum 2026 Version 1.2 (1).pdf", "docs/Local Addendum 2026 Version 1.2 (1).pdf"]

RUN mkdir -p data output backups /tmp/ucm-costing \
    && chown -R node:node data output backups /tmp/ucm-costing

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "apps/server/dist/index.js"]

FROM runtime AS development

ENV NODE_ENV=development

COPY --from=development-build --chown=node:node /app/apps/server/dist apps/server/dist
COPY --from=development-build --chown=node:node /app/apps/web/dist apps/web/dist

FROM runtime AS production
