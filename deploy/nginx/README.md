# Web role (nginx) — UI/API deploy split

Serves the prebuilt SPA bundle and reverse-proxies API/system paths to the Bun
server, on the **same origin**. Lets the UI and API deploy on independent
lifecycles:

- API rollout no longer churns asset hashes → no forced UI refresh.
- UI rollout no longer restarts the API.

Same origin (one hostname, nginx routing `/api/*` etc. to the API Service) is
deliberate: it keeps Better Auth cookies first-party. A separate `api.` domain
would need `crossSubDomainCookies` + `SameSite=None` + a CORS allowlist — out of
scope here.

## No separate image

The web pod reuses what already exists instead of building a new image:

- **bundle** — an initContainer using the **mesh image** (already on the studio
  nodes) copies `dist/client` into an emptyDir. No duplicate bundle, no
  `release-web` workflow, cache-warm pull when co-located with API pods.
- **nginx** — the **stock** `nginxinc/nginx-unprivileged` image, with the config
  mounted from a ConfigMap (`files/web-nginx.conf.template` → envsubst at start).

Pieces (all in the chart):

- `deploy/helm/studio/files/web-nginx.conf.template` — static + SPA fallback +
  reverse-proxy. `${API_UPSTREAM}` (host:port of the API Service) is substituted
  at container start.
- `deploy/helm/studio/templates/web-configmap.yaml` — mounts that config.
- `deploy/helm/studio/templates/web-deployment.yaml` + `web-service.yaml`, gated
  by `web.enabled` (default **false** → chart output unchanged).

Decoupling: pin `web.bundleImage.tag` separately from `image.tag`. Both come from
the same monorepo release; the split is about **rollout timing**, not versioning.

## Local smoke test

```bash
# 1. extract the bundle from the mesh image
mkdir -p /tmp/bundle
docker run --rm -v /tmp/bundle:/bundle --entrypoint sh \
  ghcr.io/decocms/studio/mesh:<tag> \
  -c 'cp -a /app/apps/mesh/node_modules/decocms/dist/client/. /bundle/'

# 2. serve it with stock nginx + the chart config
docker run --rm -p 8080:8080 -e API_UPSTREAM=host.docker.internal:3000 \
  -v /tmp/bundle:/usr/share/nginx/html:ro \
  -v "$PWD/deploy/helm/studio/files/web-nginx.conf.template:/etc/nginx/templates/default.conf.template:ro" \
  nginxinc/nginx-unprivileged:1.27-alpine
# → http://localhost:8080 serves the SPA; /api/* proxies to the Bun server on :3000
```

## Cutover (production)

deco prod exposes Studio via an **NLB Service** (`deco-studio-nlb` in the
`decocms/deco-apps-cd` wrapper), provisioned from annotations by
aws-load-balancer-controller — no Terraform. The NLB selects pods by label, so
the cutover is moving the front-door label from the API pods to the nginx pods.

**One-time setup** (in `deco-apps-cd`, `apps/deco-studio/values.yaml`):

1. Set `studio.web.frontDoorLabels` to a stable label, e.g.
   `{ decocms.com/frontdoor: "true" }`.
2. Change the NLB Service selector (`templates/nlb-service.yaml`) to that same
   label. While `web.enabled=false` the label sits on the API pods, so the NLB
   keeps hitting the API directly — no behavior change.

**Cutover / rollback** — just flip one value:

- `studio.web.enabled: true` → label moves to the nginx pods, NLB serves the
  bundle + proxies `/api/*` to the API ClusterIP. (Flipping rolls the pods that
  gain/lose the label once.)
- `studio.web.enabled: false` → label moves back to the API pods. Instant rollback.

With step 2, also switch `nlb.healthCheckPath` `/health` → `/healthz`: `/health`
proxies through nginx to the API, so the NLB would drop nginx from rotation
whenever the API is down; `/healthz` is nginx-local (200, no proxy).

For a plain Ingress/Gateway setup (self-host), skip `frontDoorLabels` and just
point the route at the `<fullname>-web` Service when you enable web.
