# Simplified Dockerfile - installs the locally-built decocms tarball (see below)
# Uses debian-slim (not alpine) because @duckdb/node-bindings requires glibc
FROM oven/bun:1-slim

# The package tarball is built once by CI (build-dist job) and dropped into the
# build context as decocms.tgz. Installing that exact tarball keeps this image
# byte-identical to `bunx decocms@<version>` and avoids any npm-registry
# round-trip (and propagation race) at image-build time.

# Install runtime dependencies plus the toolchain needed to compile node-pty.
# - ca-certificates: the oven/bun:1-slim base ships NO system CA bundle, but
#   DuckDB's native httpfs (OpenSSL) needs the OS trust store to verify TLS to
#   storage.googleapis.com. Without it the GCS monitoring read fails with
#   "Problem with the SSL CA cert (path? access rights?)". Bun/Node bundle their
#   own roots so they're unaffected; only the native extension needs this.
#   Named explicitly so it's marked manually-installed and survives the
#   --auto-remove purge below.
# - unzip: needed by embedded-postgres.
# - python3 + build-essential: node-pty ships prebuilt binaries only for
#   darwin/win32, so on Linux `bun add` falls back to `node-gyp rebuild`. We
#   purge this toolchain after install to keep the layer lean.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates unzip python3 build-essential && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user and app directories
RUN groupadd -g 1001 bunapp && \
    useradd -u 1001 -g bunapp -m -s /bin/sh bunuser && \
    mkdir -p /app/data /app/apps/api && \
    chown -R bunuser:bunapp /app

# Switch to non-root user before installing (so node_modules is owned by bunuser)
USER bunuser
WORKDIR /app/apps/api

# Install the locally-built package tarball (provided via the build context).
COPY decocms.tgz /tmp/decocms.tgz
RUN bun add /tmp/decocms.tgz

# Drop the build toolchain now that native modules have been compiled.
# Also create the DuckDB extension dir (owned by bunuser) where httpfs is baked.
USER root
RUN apt-get purge -y --auto-remove python3 build-essential && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /opt/duckdb/extensions && \
    chown -R bunuser:bunapp /opt/duckdb
USER bunuser

# Bake the DuckDB httpfs extension into the image so the GCS monitoring read
# path never reaches the DuckDB extension CDN at runtime (strict-outbound
# self-hosters). At runtime DuckDBEngine sets autoinstall/autoload off and
# LOADs from this directory. Network is available here at build time.
ENV DUCKDB_EXTENSION_DIRECTORY=/opt/duckdb/extensions
RUN bun -e "const {DuckDBInstance}=await import('@duckdb/node-api'); const c=await (await DuckDBInstance.create('',{threads:'1'})).connect(); await c.run(\"SET extension_directory='/opt/duckdb/extensions'; INSTALL httpfs;\");"

# Expose the default port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production
# Preserve the historical filename so existing `/app/data` volumes keep their
# database across the app-directory split.
ENV DATABASE_URL=file:/app/data/mesh.db

# The CLI handles migrations automatically on startup
# Use --skip-migrations if you want to manage migrations separately
CMD ["bun", "run", "deco", "--no-tui", "--no-local-mode"]
