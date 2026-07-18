# syntax=docker/dockerfile:1.7

FROM --platform=$BUILDPLATFORM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /src

# The terminal PWA remains the existing packages/web application. Install its
# locked workspace first, then the site's independent locked workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY scripts/fix-pty-perms.mjs scripts/fix-pty-perms.mjs
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN pnpm install --filter @roamcode.ai/web... --frozen-lockfile --ignore-scripts

COPY site/package.json site/pnpm-lock.yaml site/pnpm-workspace.yaml site/
RUN pnpm --dir site install --frozen-lockfile

COPY packages/web packages/web
COPY site site
RUN pnpm --dir site build

FROM --platform=$BUILDPLATFORM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS validate

COPY packaging/relay/Caddyfile /etc/caddy/Caddyfile
RUN ROAMCODE_DOMAIN=http://roamcode.example.invalid \
    ROAMCODE_API_UPSTREAM=api:4400 ROAMCODE_RELAY_UPSTREAM=relay:4281 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS runtime

RUN addgroup -S -g 10002 roamcode-gateway && \
    adduser -S -D -H -u 10002 -G roamcode-gateway roamcode-gateway && \
    install -d -o roamcode-gateway -g roamcode-gateway -m 0750 /data /config
COPY --from=validate /etc/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/site/dist /srv
COPY scripts/install.sh /srv/install

USER 10002:10002
