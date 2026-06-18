# Builds the SPA bundle and serves it via nginx — the "web" deployment role.
# Static assets + SPA fallback are served locally; API/system paths reverse-proxy
# to the Bun server (same origin → auth cookies stay first-party, no CORS rework).
# Decoupling the bundle into its own image means an API rollout no longer churns
# asset hashes (no forced UI refresh) and a UI rollout no longer restarts the API.

# ── Stage 1: build the client bundle ──────────────────────────────────────
# Pinned to BUILDPLATFORM so a multi-arch build never re-runs `bun install`
# under QEMU emulation — the bundle is just static files, arch-independent.
FROM --platform=$BUILDPLATFORM oven/bun:1 AS build
WORKDIR /repo
COPY . .
# --ignore-scripts: the client build (vite) is pure JS/TS — it doesn't need the
# native postinstall builds (e.g. node-pty's node-gyp), which would otherwise
# fail here for lack of a C toolchain in the bun base image.
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run --cwd=apps/mesh build:client

# ── Stage 2: nginx serving the bundle ─────────────────────────────────────
# nginx-unprivileged listens on 8080 and runs as a non-root user (uid 101) out
# of the box — satisfies the chart's runAsNonRoot securityContext with no fuss.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /repo/apps/mesh/dist/client /usr/share/nginx/html
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
# API_UPSTREAM (host:port of the Bun API Service) is substituted into proxy_pass
# at container start by the stock entrypoint (envsubst over /etc/nginx/templates).
ENV API_UPSTREAM=deco-studio:80
EXPOSE 8080
