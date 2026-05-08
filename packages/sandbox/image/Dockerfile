# Build: docker build -t studio-sandbox:local -f packages/sandbox/image/Dockerfile packages/sandbox
FROM oven/bun:1.3.13-debian

ARG NODE_MAJOR=22
ARG DENO_VERSION=v1.46.3

# `locales` + generated `en_US.UTF-8` is load-bearing: repos using
# `embedded-postgres` refuse to init without it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       bash ca-certificates curl git gnupg locales python3 python3-pip \
       ripgrep unzip \
  && sed -i 's/^#\s*en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
  && locale-gen \
  && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deno.land/install.sh \
       | DENO_INSTALL=/opt/deno sh -s -- -y "${DENO_VERSION}" \
  && ln -s /opt/deno/bin/deno /usr/local/bin/deno \
  && corepack enable \
  && corepack prepare yarn@stable --activate \
  && corepack prepare pnpm@latest --activate

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
# builds from source for archs without prebuilts). build-essential + python3
# are required for the node-gyp fallback on architectures (e.g. linux-arm64)
# that have no pre-built binary. build-essential is removed after the build to
# keep the layer lean. The `find … chmod +x` step ensures the spawn-helper
# binary is executable (relevant on macOS-targeted prebuilds; no-op on Linux).
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential \
  && rm -rf /var/lib/apt/lists/* \
  && cd /opt/sandbox-daemon \
  && bun init -y \
  && bun add node-pty@^1.0.0 \
  && find /opt/sandbox-daemon/node_modules/node-pty -name "spawn-helper" -exec chmod +x {} \; \
  && chown -R sandbox:sandbox /opt/sandbox-daemon \
  && apt-get purge -y --auto-remove build-essential

COPY --chown=sandbox:sandbox daemon/dist/daemon.js /opt/sandbox-daemon/daemon.js
COPY --chown=sandbox:sandbox image/skills /mnt/skills/public

# Expose skill helper scripts as bare commands. Wrappers in skills/_bin/
# are tiny shell shims; symlinking them into /usr/local/bin lets the model
# run e.g. `pptx-thumbnail deck.pptx` instead of typing the full python path.
RUN chmod +x /mnt/skills/public/_bin/* \
  && ln -s /mnt/skills/public/_bin/* /usr/local/bin/

ENV IS_SANDBOX=1
USER sandbox
EXPOSE 9000
CMD ["bun", "/opt/sandbox-daemon/daemon.js"]
