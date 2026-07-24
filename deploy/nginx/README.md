# Studio nginx front door

Studio ships a companion nginx image for the Helm chart. The image contains the
built SPA assets and the baked proxy configuration used by the main API pod.
There is no separate web Deployment, initContainer bundle copy, PVC handoff, or
ConfigMap-mounted nginx template.

The Helm chart runs nginx inside every main API pod as the service-facing
container:

- nginx listens on `8080`, owns the pod's `http` port, serves
  `/usr/share/nginx/html`, and returns `/healthz` locally.
- API/system paths such as `/api`, `/mcp`, `/oauth-proxy`, `/.well-known`,
  `/org`, `/health`, and `/metrics` proxy to the two local Bun API containers.
- Preview hostnames matching `<handle>.preview.<base>` proxy all paths to the
  API so sandbox preview requests do not fall through to the SPA fallback.
- `/assets/*` is served with immutable cache headers; missing assets return 404
  with `no-store` to avoid negative-cache poisoning.

The config is `deploy/helm/studio/files/api-nginx.conf`. It is copied into the
image by `apps/web/Dockerfile` as `/etc/nginx/conf.d/default.conf`, so the
runtime keeps the base `nginxinc/nginx-unprivileged` entrypoint and global
settings.

## Image release

`.github/workflows/release-mesh.yaml` publishes the nginx image as a first-class
release artifact alongside the Bun API image:

```text
ghcr.io/decocms/studio/studio:<version>
ghcr.io/decocms/studio/studio-nginx:<version>
```

Both images are built from the same package artifact and version tag. The chart
defaults to `nginx.image.repository: ghcr.io/decocms/studio/studio-nginx`; set
`nginx.image.tag` with the same release tag used for `image.tag` when pinning a
deployment.

## Local smoke test

```bash
# Build from the repository root after the release package artifact exists as
# ./decocms.tgz, matching the GitHub Actions build context.
docker build -f apps/web/Dockerfile -t studio-nginx:local .

# Run nginx and point it at a local Bun API server.
docker run --rm -p 8080:8080 --add-host=host.docker.internal:host-gateway \
  studio-nginx:local
```

For local proxy testing without a pod network, temporarily replace the upstream
servers in `deploy/helm/studio/files/api-nginx.conf` with
`host.docker.internal:3000` before building the image. In Kubernetes, nginx
always proxies to `127.0.0.1:3000` and `127.0.0.1:3001` inside the same pod.

## Operations

The public Service targets nginx through `targetPort: http`; do not route
traffic directly to the Bun API container ports. Use `/healthz` for front-door
health checks when you need an nginx-local probe. `/health` and `/metrics` are
proxied to the API.

Rollouts and rollbacks now move both images together by tag. To roll back the
front door and API consistently, set both `image.tag` and `nginx.image.tag` to
the previous release.
