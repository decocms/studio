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
# `openssh-client` ships the `ssh-keygen` that signs commits; git only
# Recommends it, and this installs with --no-install-recommends.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git gnupg libatomic1 locales openssh-client \
       python3 python3-pip ripgrep unzip zstd \
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

# Headless browser for the QA reviewer's `qa-screenshot` (below). Debian's own
# `chromium` package, driven by `playwright-core` — the API only, no browser
# download. Playwright's `install --with-deps chromium` is avoided on purpose:
# on Debian it falls back to an Ubuntu dependency list and dies on obsolete font
# packages (ttf-unifont / ttf-ubuntu-font-family).
#
# This is the one heavy thing in the image that only ONE kind of run uses (~700MB
# measured). It lives in the base image anyway, rather than a separate QA image:
# a second image needs a second SandboxTemplate, its own warm pool, and per-run
# routing to pick between them — infrastructure that costs more to operate than
# the bytes cost to carry. Revisit if image pull ever shows up in cold-start
# numbers; `playwright install --only-shell` is the lighter option, but its
# saving comes from the shared libraries, so it only pays off if those are
# already present.
ARG PLAYWRIGHT_VERSION=1.55.0
ENV QA_CHROMIUM=/usr/bin/chromium
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "playwright-core@${PLAYWRIGHT_VERSION}" \
  && chromium --version

# WebKit, for `qa-screenshot --engine=webkit`: Safari's engine, which Chromium
# cannot stand in for (it re-aligns a smooth programmatic scroll to scroll-snap
# points, WebKit does not). Playwright's own build, the revision this
# playwright-core pins, since Debian ships no WebKit Playwright can drive.
#
# Headless WebKit runs the WPE MiniBrowser; the GTK one exists for headed runs,
# which a pod with no display cannot do, so it is deleted (~120MB). The
# packages are what the WPE bundle links against, read off its ELF NEEDED
# entries on this Debian, plus what it loads at runtime: glib-networking for
# TLS, GStreamer base/good/libav for <video> (libav is H.264, and Playwright
# refuses to launch without it). Not gstreamer1.0-plugins-bad: Playwright's own
# list asks for it, but H.264 and MSE play without it, and it costs ~100MB.
#
# The download runs under bun, not node: before 1.60, playwright-core hangs
# extracting the archive on Node 24.16+ (microsoft/playwright#40724). Its host
# check is skipped there because it would flag the GTK bundle deleted next; the
# closing launch runs that check, so a missing library fails the build rather
# than the first QA run.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       glib-networking gstreamer1.0-libav gstreamer1.0-plugins-base \
       gstreamer1.0-plugins-good libatk-bridge2.0-0t64 libatk1.0-0t64 \
       libavif16 libbrotli1 libdrm2 libepoxy0 libevent-2.1-7t64 libflite1 \
       libfontconfig1 libfreetype6 libgbm1 libgcrypt20 libgles2 \
       libglib2.0-0t64 libgpg-error0 libgstreamer-gl1.0-0 \
       libgstreamer-plugins-bad1.0-0 libgstreamer-plugins-base1.0-0 \
       libgstreamer1.0-0 libharfbuzz-icu0 libharfbuzz0b libicu76 \
       libjpeg62-turbo libjxl0.11 liblcms2-2 libnghttp2-14 libopus0 \
       libpng16-16t64 libpsl5t64 libsqlite3-0 libtasn1-6 libvpx9 \
       libwayland-client0 libwayland-egl1 libwayland-server0 libwebp7 \
       libwebpdemux2 libwebpmux3 libwoff1 libxkbcommon0 libxml2 libxslt1.1 \
  && rm -rf /var/lib/apt/lists/* \
  && PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
       bun /usr/local/lib/node_modules/playwright-core/cli.js install webkit \
  && rm -rf "${PLAYWRIGHT_BROWSERS_PATH}"/webkit-*/minibrowser-gtk \
  && node -e 'require("/usr/local/lib/node_modules/playwright-core").webkit.launch().then((b) => { console.log("webkit", b.version()); return b.close(); })'

# Install the @decocms/cli build (the `decocms` command) produced from this
# exact source revision. Installing from npm here would race the post-merge
# package release and could bake a CLI older than this daemon.
COPY --chown=sandbox:sandbox dist/cli.tgz /opt/sandbox-daemon/cli.tgz
RUN npm install -g /opt/sandbox-daemon/cli.tgz

COPY --chown=sandbox:sandbox image/skills /mnt/skills/public

# Expose skill helper scripts as bare commands. Wrappers in skills/_bin/
# are tiny shell shims; symlinking them into /usr/local/bin lets the model
# run e.g. `pptx-thumbnail deck.pptx` instead of typing the full python path.
RUN chmod +x /mnt/skills/public/_bin/* \
  && ln -s /mnt/skills/public/_bin/* /usr/local/bin/

# The QA reviewer's screenshot helper, driving the chromium installed above.
COPY --chown=sandbox:sandbox image/bin/qa-screenshot /usr/local/bin/qa-screenshot
RUN chmod +x /usr/local/bin/qa-screenshot

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

# `glab`, the GitLab counterpart: agents working on a GitLab-hosted repository
# open merge requests with it, fed GITLAB_TOKEN, GITLAB_HOST and GLAB_IS_OAUTH2
# per run by the daemon (same RunEnv, keyed off the clone URL's `oauth2`
# userinfo). Release tarball, pinned, per-arch — same reasoning as `gh` above.
# Keep it at 1.82.0 or later: older releases require an `oauth2_expiry_date`
# the daemon's glab config does not carry, and fail every API call before
# sending it.
ARG GLAB_CLI_VERSION=1.119.0
RUN arch="$(dpkg --print-architecture)" \
  && curl -fsSL --retry 3 \
       "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_CLI_VERSION}/downloads/glab_${GLAB_CLI_VERSION}_linux_${arch}.tar.gz" \
     | tar -xz -C /tmp \
  && mv /tmp/bin/glab /usr/local/bin/glab \
  && rm -rf /tmp/bin \
  && glab --version
# The daemon rewrites glab's config before every run, which resets the state
# that limits the update check to once a day and the post-upgrade banner to
# once per version. Left on, the first glab command of every run can end with
# an update notice and the banner, pushing its own output (an MR link) out of
# a `| tail`. Telemetry would report an agent's commands to the GitLab
# instance as the user's own.
ENV GLAB_CHECK_UPDATE=0 \
    GLAB_SHOW_WHATS_NEW=0 \
    GLAB_SEND_TELEMETRY=0

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
ARG CLAUDE_CODE_CLI_VERSION=2.1.280
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
