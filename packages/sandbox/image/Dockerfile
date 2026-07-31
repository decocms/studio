# Two images, one shared base. The daemon implementation is the image, not a
# runtime switch: one SandboxTemplate per image, and a claim picks the template.
#
#   TS  (default): docker build -t studio-sandbox:local              -f packages/sandbox/image/Dockerfile packages/sandbox
#   Go:            docker build -t studio-sandbox-go:local --target go -f packages/sandbox/image/Dockerfile packages/sandbox
#
# `ts` is deliberately the LAST stage so it stays the implicit `--target`, and
# every existing build command keeps producing the TS image.
#
# Everything expensive (LibreOffice, Python, Node, Deno, corepack, node-pty)
# lives in `runtime-base`, so the two images are byte-identical below their
# daemon layer and the second build is nearly free from cache. Do not move a
# shared dependency into a leaf stage — that is how the two drift.
#
# Published multi-arch (linux/amd64 + linux/arm64) by
# .github/workflows/release-studio-sandbox.yaml so sandboxes run natively on
# arm64 nodes (Apple Silicon, arm64 cloud) as well as amd64.
ARG NODE_MAJOR=26

# Node comes from the official image instead of NodeSource's apt repo: the
# deb.nodesource.com setup script 403s intermittently (outages last hours and
# retries don't save the build), while this pull rides the same registry +
# digest cache the base image already depends on. Multi-arch like the rest.
FROM node:${NODE_MAJOR}-slim AS node-dist

# The Go daemon. Only the `go` target consumes this stage, so a `--target ts`
# build skips it entirely. Every dep is pure Go, so CGO_ENABLED=0
# cross-compiles without emulation.
FROM --platform=$BUILDPLATFORM golang:1.25-bookworm AS daemon-go
ARG TARGETARCH
WORKDIR /src
COPY daemon-go/go.mod daemon-go/go.sum ./
RUN go mod download
COPY daemon-go/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH="${TARGETARCH}" \
      go build -trimpath -ldflags="-s -w" -o /out/daemon-go .

FROM oven/bun:1.3.14-debian AS runtime-base

ARG COREPACK_VERSION=0.35.0
ARG DENO_VERSION=v1.46.3

COPY --from=node-dist /usr/local/bin/node /usr/local/bin/node
COPY --from=node-dist /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# `locales` + generated `en_US.UTF-8` is load-bearing: repos using
# `embedded-postgres` refuse to init without it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git gnupg libatomic1 locales python3 \
       python3-pip ripgrep unzip zstd \
  && sed -i 's/^#\s*en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen \
  && node --version \
  && npm --version \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deno.land/install.sh \
       | DENO_INSTALL=/opt/deno sh -s -- -y "${DENO_VERSION}" \
  && ln -s /opt/deno/bin/deno /usr/local/bin/deno \
  # Node 26 no longer ships Corepack in its dist.
  && (command -v corepack >/dev/null 2>&1 \
       || npm install --global "corepack@${COREPACK_VERSION}") \
  && corepack enable \
  # Corepack fetches the tarballs from npm under the hood; if cloudflare
  # closes the TLS socket mid-stream (UND_ERR_SOCKET in undici) the build
  # fails. Retry each `prepare` up to 3 times with growing backoff.
  && (corepack prepare yarn@stable --activate \
       || (sleep 5 && corepack prepare yarn@stable --activate) \
       || (sleep 15 && corepack prepare yarn@stable --activate)) \
  && (corepack prepare pnpm@latest --activate \
       || (sleep 5 && corepack prepare pnpm@latest --activate) \
       || (sleep 15 && corepack prepare pnpm@latest --activate))

# Office tooling used by /mnt/skills/public/* document skills:
# - LibreOffice headless for pptx/xlsx/docx → PDF conversion (rasterization,
#   formula recalc, accept-tracked-changes).
# - Poppler suite for PDF inspection and page-image extraction (pdftoppm,
#   pdfinfo, pdftotext, pdfimages, pdfdetach, pdffonts).
# - dbus + a generated /etc/machine-id so soffice doesn't warn on every call.
# - DejaVu + Liberation fonts so soffice renders text instead of fallback
#   tofu glyphs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       libreoffice-impress poppler-utils dbus \
       fonts-dejavu-core fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && dbus-uuidgen > /etc/machine-id

# Python libraries used by /mnt/skills/public/* helper scripts.
RUN pip3 install --break-system-packages --no-cache-dir \
      python-pptx python-docx openpyxl pypdf Pillow

ENV LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8

# Convert silent stalls (NAT instance replacement, PMTUD blackholes, mid-stream
# packet drops) into fast errors that the daemon's clone retry loop can catch.
# Without this, libcurl waits on TCP keepalive (~2h default) and the clone
# hangs at "Receiving objects" indefinitely.
RUN git config --system http.lowSpeedLimit 1000 \
  && git config --system http.lowSpeedTime 30

# Non-root sandbox user. The bun image comes with a 'bun' user (UID 1000),
# but we drop privileges further by replacing it with a 'sandbox' user.
RUN userdel --remove bun \
  && useradd --create-home --uid 1000 --user-group --shell /bin/bash sandbox \
  && mkdir -p /app /opt/sandbox-daemon \
  && chown -R sandbox:sandbox /app /opt/sandbox-daemon

WORKDIR /app

# node-pty is a native addon. The daemon bundle marks it `--external`, so it
# must be installed inside the image. `bun init -y` creates a minimal
# package.json; `bun add` triggers node-pty's prebuilt-binary download (or
# builds from source for archs without prebuilts). build-essential + python3 +
# node-gyp are required for the node-gyp fallback on architectures (e.g.
# linux-arm64) that have no pre-built binary. They are kept in the final
# image so user repos in /app/repo that depend on node-pty (or any native
# addon) can rebuild during their own `bun install`. The `find … chmod +x`
# step ensures the spawn-helper binary is executable (relevant on
# macOS-targeted prebuilds; no-op on Linux).
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g node-gyp \
  && cd /opt/sandbox-daemon \
  && bun init -y \
  && bun add node-pty@^1.0.0 \
  && find /opt/sandbox-daemon/node_modules/node-pty -name "spawn-helper" -exec chmod +x {} \; \
  && chown -R sandbox:sandbox /opt/sandbox-daemon

# Install the typegen build produced from this exact source revision. Installing
# from npm here would race the post-merge package release and could bake the
# previous CLI, which does not discover the materialized endpoint file.
COPY --chown=sandbox:sandbox daemon/dist/typegen.tgz /opt/sandbox-daemon/typegen.tgz
RUN npm install -g /opt/sandbox-daemon/typegen.tgz

COPY --chown=sandbox:sandbox image/skills /mnt/skills/public

# Expose skill helper scripts as bare commands. Wrappers in skills/_bin/
# are tiny shell shims; symlinking them into /usr/local/bin lets the model
# run e.g. `pptx-thumbnail deck.pptx` instead of typing the full python path.
RUN chmod +x /mnt/skills/public/_bin/* \
  && ln -s /mnt/skills/public/_bin/* /usr/local/bin/

ENV IS_SANDBOX=1
USER sandbox
EXPOSE 9000

# ── Go daemon image ─────────────────────────────────────────────────────────
# `studio-sandbox-go`. No daemon.js: nothing in this image can start the TS
# daemon, which is the point — the running implementation is a property of the
# image, provable by inspection rather than by reading an env var.
FROM runtime-base AS go
COPY --from=daemon-go --chown=sandbox:sandbox /out/daemon-go /opt/sandbox-daemon/daemon-go
# exec form, so the daemon is PID 1 and gets SIGTERM directly — that is what
# triggers the shutdown git publish.
CMD ["/opt/sandbox-daemon/daemon-go"]

# ── TS daemon image (default target) ────────────────────────────────────────
# `studio-sandbox`. Last stage on purpose: this is what a bare `docker build`
# produces, so no existing build command changes meaning.
FROM runtime-base AS ts
COPY --chown=sandbox:sandbox daemon/dist/daemon.js /opt/sandbox-daemon/daemon.js
CMD ["bun", "/opt/sandbox-daemon/daemon.js"]
