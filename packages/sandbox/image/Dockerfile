# The sandbox image. One daemon, written in Go (`daemon-go/`):
#
#   docker build -t studio-sandbox-go:local -f packages/sandbox/image/Dockerfile packages/sandbox
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

# The daemon. Every dep is pure Go, so CGO_ENABLED=0 cross-compiles without
# emulation.
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

# build-essential + python3 + node-gyp for user repos in /app/repo that depend
# on a native addon and rebuild it during their own `bun install`. The daemon
# itself is a static Go binary and needs none of this.
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g node-gyp

# Install the typegen build produced from this exact source revision. Installing
# from npm here would race the post-merge package release and could bake the
# previous CLI, which does not discover the materialized endpoint file.
COPY --chown=sandbox:sandbox dist/typegen.tgz /opt/sandbox-daemon/typegen.tgz
RUN npm install -g /opt/sandbox-daemon/typegen.tgz

COPY --chown=sandbox:sandbox image/skills /mnt/skills/public

# Expose skill helper scripts as bare commands. Wrappers in skills/_bin/
# are tiny shell shims; symlinking them into /usr/local/bin lets the model
# run e.g. `pptx-thumbnail deck.pptx` instead of typing the full python path.
RUN chmod +x /mnt/skills/public/_bin/* \
  && ln -s /mnt/skills/public/_bin/* /usr/local/bin/

# `gh`, so an agent can open the pull request its task prompt asks for. Pushing
# already works off the credentialed `origin` git clone stored; `gh` is the half
# that was missing, and the daemon hands it GH_TOKEN per run (see
# daemon-go/main.go RunEnv). From the release tarball rather than the apt repo:
# one layer, no extra keyring, and the version is pinned like every other tool
# here. `dpkg --print-architecture` matches gh's asset naming (amd64/arm64), so
# each leg of the multi-arch build takes its own.
ARG GH_CLI_VERSION=2.97.0
RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL --retry 3 \
       "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_${arch}.tar.gz" \
     | tar -xz -C /tmp \
  && mv "/tmp/gh_${GH_CLI_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh \
  && rm -rf "/tmp/gh_${GH_CLI_VERSION}_linux_${arch}" \
  && gh --version

# The claude-code harness: the Claude Agent SDK (a TS library) plus the `claude`
# CLI it drives. The daemon execs the runner once per run — see
# daemon-go/internal/dispatch/runner.go and packages/harness-runner/README.md.
#
# The two versions are ONE release train and must move together: the SDK pins
# `@anthropic-ai/claude-agent-sdk` in packages/harness-runner/package.json and
# ships a manifest naming the CLI build it expects (0.3.<N> ↔ 2.1.<N>). Bumping
# one without the other is how you get a runner that starts and then fails every
# turn on a version handshake.
#
# The CLI is a ~270MB native binary delivered through per-platform
# optionalDependencies, so npm resolves the right arch on each leg of the
# multi-arch build. It is deliberately NOT a dependency of the harness-runner
# workspace — that would put 270MB into every developer's `bun install`.
ARG CLAUDE_CODE_CLI_VERSION=2.1.220
COPY --chown=sandbox:sandbox dist/harness-runner.tgz /opt/sandbox-daemon/harness-runner.tgz
RUN npm install -g /opt/sandbox-daemon/harness-runner.tgz \
  && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}" \
  && claude --version

# Claude Code discovers skills as `<config-dir>/skills/<name>/SKILL.md`, so the
# image's shared skills are symlinked in rather than copied. CLAUDE_CONFIG_DIR
# keeps the whole config dir relocatable: pointing it at a persisted mount is
# what lets a thread's session survive pod replacement, with no code change.
ENV CLAUDE_CONFIG_DIR=/home/sandbox/.claude \
    CLAUDE_CODE_PATH=/usr/local/bin/claude \
    HARNESS_RUNNER_CMD=decocms-harness-runner
RUN mkdir -p /home/sandbox/.claude \
  && ln -s /mnt/skills/public /home/sandbox/.claude/skills \
  && chown -R sandbox:sandbox /home/sandbox/.claude

ENV IS_SANDBOX=1
USER sandbox
EXPOSE 9000

COPY --from=daemon-go --chown=sandbox:sandbox /out/daemon-go /opt/sandbox-daemon/daemon-go
# exec form, so the daemon is PID 1 and gets SIGTERM directly — that is what
# triggers the shutdown git publish.
CMD ["/opt/sandbox-daemon/daemon-go"]
