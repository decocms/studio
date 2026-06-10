# org-fs sidecar: FUSE-mounts organization filesystem volumes inside sandbox
# pods (see packages/sandbox/daemon/org-fs/sidecar.ts). Runs privileged with
# Bidirectional mount propagation — see the orgFs block in ../values.yaml.
#
# Build context is the REPO ROOT (the bundle pulls TS from packages/ and
# apps/mesh): docker build -f deploy/helm/sandbox-env/orgfs-sidecar/Dockerfile .

FROM oven/bun:1.3.14-debian AS build
WORKDIR /repo
# Only the sidecar's import graph — no full workspace install. @decocms/std is
# a zero-dependency workspace package; a hand-made node_modules link resolves
# the specifier without bun install.
COPY packages/std packages/std
COPY packages/sandbox/daemon packages/sandbox/daemon
COPY apps/mesh/src/file-storage/mount apps/mesh/src/file-storage/mount
RUN mkdir -p node_modules/@decocms \
  && ln -s ../../packages/std node_modules/@decocms/std \
  && bun build packages/sandbox/daemon/org-fs/sidecar-main.ts \
    --target bun --outfile /out/sidecar.js

FROM oven/bun:1.3.14-debian
LABEL org.opencontainers.image.source="https://github.com/decocms/studio"
# rclone does the FUSE mounting; user_allow_other lets the unprivileged main
# container (different uid) read the mounts after propagation.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone fuse3 ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && echo user_allow_other >> /etc/fuse.conf
COPY --from=build /out/sidecar.js /srv/sidecar.js
CMD ["bun", "run", "/srv/sidecar.js"]
