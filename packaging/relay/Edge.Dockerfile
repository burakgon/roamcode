# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /src

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY scripts/fix-pty-perms.mjs scripts/fix-pty-perms.mjs
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages/web packages/web
RUN cd packages/web && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vite build

FROM --platform=$BUILDPLATFORM caddy:2.10.2-alpine AS validate

COPY packaging/relay/Caddyfile /etc/caddy/Caddyfile
RUN ROAMCODE_APP_DOMAIN=app.example.invalid ROAMCODE_RELAY_DOMAIN=relay.example.invalid \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

FROM caddy:2.10.2-alpine AS runtime

RUN addgroup -S -g 10002 roamcode-edge && \
    adduser -S -D -H -u 10002 -G roamcode-edge roamcode-edge && \
    install -d -o roamcode-edge -g roamcode-edge -m 0750 /data /config
COPY --from=validate /etc/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/packages/web/dist /srv

USER 10002:10002
