# Simplified Dockerfile - uses pre-built npm package
FROM oven/bun:1-alpine

# Version to install (override with --build-arg MESH_VERSION=1.0.0)
ARG MESH_VERSION=latest

# Create non-root user and app directories
RUN addgroup -g 1001 -S bunapp && \
    adduser -u 1001 -S -G bunapp bunuser && \
    mkdir -p /app/data /app/apps/mesh && \
    chown -R bunuser:bunapp /app

# Switch to non-root user before installing (so node_modules is owned by bunuser)
USER bunuser
WORKDIR /app/apps/mesh

# Install the package locally during build (cached in image layer)
RUN bun add decocms@${MESH_VERSION}

# Expose the default port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production
ENV DATABASE_URL=file:/app/data/mesh.db

# The CLI handles migrations automatically on startup
# Use --skip-migrations if you want to manage migrations separately
CMD ["bun", "run", "deco", "--no-local-mode"]