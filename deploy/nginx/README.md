# Web image (nginx) — UI/API deploy split

Serves the prebuilt SPA bundle and reverse-proxies API/system paths to the Bun
server, on the **same origin**. Lets the UI and API deploy on independent
lifecycles:

- API rollout no longer churns asset hashes → no forced UI refresh.
- UI rollout no longer restarts the API.

Same origin (one hostname, nginx routing `/api/*` etc. to the API Service) is
deliberate: it keeps Better Auth cookies first-party. A separate `api.` domain
would need `crossSubDomainCookies` + `SameSite=None` + a CORS allowlist — out of
scope here.

## Pieces

- `Dockerfile` — multi-stage: builds `apps/mesh` client bundle, copies into
  `nginxinc/nginx-unprivileged`. Built/pushed by `.github/workflows/release-web.yaml`
  as `ghcr.io/decocms/studio/web:<version>`.
- `default.conf.template` — static + SPA fallback + reverse-proxy. `${API_UPSTREAM}`
  (host:port of the API Service) is substituted at container start.
- Helm: `web-deployment.yaml` + `web-service.yaml`, gated by `web.enabled`
  (default **false** → chart output unchanged).

## Local build / smoke test

```bash
docker build -f deploy/nginx/Dockerfile -t studio-web .
docker run --rm -p 8080:8080 -e API_UPSTREAM=host.docker.internal:3000 studio-web
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

For a plain Ingress/Gateway setup (self-host), skip `frontDoorLabels` and just
point the route at the `<fullname>-web` Service when you enable web.
