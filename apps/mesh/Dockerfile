# Simplified Dockerfile - installs the locally-built decocms tarball (see below)
# Uses debian-slim (not alpine) because @duckdb/node-bindings requires glibc
FROM oven/bun:1-slim

# The package tarball is built once by CI (build-dist job) and dropped into the
# build context as decocms.tgz. Installing that exact tarball keeps this image
# byte-identical to `bunx @decocms/mesh@<version>` and avoids any npm-registry
# round-trip (and propagation race) at image-build time.

# Install runtime dependencies (unzip needed by embedded-postgres) plus the
# toolchain needed to compile node-pty from source. node-pty ships prebuilt
# binaries only for darwin/win32, so on Linux `bun add` always falls back to
# `node-gyp rebuild` — which needs python3 + build-essential. We purge the
# build toolchain after install to keep the layer lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
      unzip python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user and app directories
RUN groupadd -g 1001 bunapp && \
    useradd -u 1001 -g bunapp -m -s /bin/sh bunuser && \
    mkdir -p /app/data /app/apps/mesh && \
    chown -R bunuser:bunapp /app

# Switch to non-root user before installing (so node_modules is owned by bunuser)
USER bunuser
WORKDIR /app/apps/mesh

# Install the locally-built package tarball (provided via the build context).
COPY decocms.tgz /tmp/decocms.tgz
RUN bun add /tmp/decocms.tgz

# Drop the build toolchain now that native modules have been compiled.
USER root
RUN apt-get purge -y --auto-remove python3 build-essential && \
    rm -rf /var/lib/apt/lists/*
USER bunuser

# Expose the default port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/mesh.db

# The CLI handles migrations automatically on startup
# Use --skip-migrations if you want to manage migrations separately
CMD ["bun", "run", "deco", "--no-tui", "--no-local-mode"]