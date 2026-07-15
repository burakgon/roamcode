# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS source-build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY scripts/fix-pty-perms.mjs scripts/fix-pty-perms.mjs
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages/server packages/server
RUN cd packages/server && ../../node_modules/.bin/tsup

FROM node:24-bookworm-slim AS runtime-dependencies

RUN apt-get update && \
    apt-get install --yes --no-install-recommends g++ make python3 && \
    rm -rf /var/lib/apt/lists/*
WORKDIR /runtime
COPY packaging/relay/package.json packaging/relay/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=source-build /src/packages/server/dist/container/relay.js /runtime/relay.js

FROM node:24-bookworm-slim AS runtime

RUN groupadd --system --gid 10001 roamcode && \
    useradd --system --uid 10001 --gid roamcode --home-dir /var/lib/roamcode-relay --shell /usr/sbin/nologin roamcode && \
    install -d -o roamcode -g roamcode -m 0700 /var/lib/roamcode-relay
WORKDIR /app
COPY --from=runtime-dependencies --chown=roamcode:roamcode /runtime/ ./

ENV NODE_ENV=production \
    ROAMCODE_RELAY_BIND=0.0.0.0 \
    ROAMCODE_RELAY_PORT=4281 \
    ROAMCODE_RELAY_DATA_DIR=/var/lib/roamcode-relay

USER 10001:10001
EXPOSE 4281
VOLUME ["/var/lib/roamcode-relay"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4281/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["node", "relay.js"]
