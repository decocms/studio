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

## Cutover (production, in the GitOps repo — not here)

1. `helm` values: `web.enabled: true` (brings up the `<fullname>-web`
   Deployment + Service; nothing else changes).
2. Confirm the web pods are ready and `<fullname>-web` proxies `/api/*`.
3. Repoint the external gateway/HTTPRoute hostname from the main Service to the
   `<fullname>-web` Service.
4. Rollback = repoint back / `web.enabled: false`.
