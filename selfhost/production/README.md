# Running Studio in production

Production is **not** the umbrella. Install the lean chart
([`deploy/helm/studio`](../../deploy/helm/studio)) **directly** and point it at
**managed** dependencies. Nothing here bundles a database or object store.

| Concern | Local (umbrella) | Production |
|---------|------------------|------------|
| PostgreSQL | throwaway pod (emptyDir) | managed (RDS/Cloud SQL) **or** your own in-cluster — `database.url` |
| Object storage | bundled MinIO | managed S3/GCS/R2 **or** in-cluster MinIO/Ceph — `S3_*` |
| ClickHouse | bundled (opt-in) | Cloud, in-cluster subcharts, **or** none — `CLICKHOUSE_URL` |
| NATS | bundled subchart | bundled is fine; run your own for HA |
| Secrets | fixed dev values in the chart | **ExternalSecret** OR a Secret you create (`secret.secretName`) — never inline |
| Scaling | single replicas, HPA off | **HPA on** for API + worker |
| Ingress | `LoadBalancer:80` servicelb | your ingress controller / LB / gateway (chart renders none) |
| Previews | Studio in-process proxy on `:80` | **preview Gateway** (Istio + cert-manager wildcard) |
| Sandbox egress | open | **locked down** (netinit iptables) + node isolation |

## Recommended: bundle it in your own umbrella (wrapper) chart

Rather than installing several charts by hand and threading shared values between
them (easy to get wrong — a missing ServiceAccount or an unshared sentinel token
breaks the sandbox), wrap them in a small **umbrella chart you own**, install it
as one release, and extend it with your own extras. This is exactly how the local
`examples/k8s-local` works — and how deco's own internal deploy does it
(`deco-apps-cd`'s `deco-studio` wraps `chart-deco-studio` + its ExternalSecrets).

`your-studio/Chart.yaml`:

```yaml
apiVersion: v2
name: your-studio
version: 0.1.0
dependencies:
  - name: chart-deco-studio
    version: "<pin>"
    repository: "oci://ghcr.io/decocms"   # or file://… if vendored
  - name: sandbox-operator
    version: "<pin>"
    repository: "oci://ghcr.io/decocms"
  - name: sandbox-env
    version: "<pin>"
    repository: "oci://ghcr.io/decocms"
```

Then `your-studio/values.yaml` wires all three consistently (SA, the shared
sentinel token on both sides, S3, DB), and `your-studio/templates/` is where you
add YOUR extras — ExternalSecrets, an Ingress, a Postgres `Cluster` (CNPG), extra
config — without forking the app chart. One `helm install`, everything lines up.

> The umbrella must span two namespaces (Studio in yours, the sandbox operator in
> `agent-sandbox-system`); set `sandbox-operator.allowForeignNamespace=true` (the
> sandbox resources self-pin to `agent-sandbox-system` regardless). See
> `examples/k8s-local` for a complete, working example to copy.

## Studio app (installing the charts directly)

If you'd rather not wrap, install the charts directly. Start from
[`values-studio-prod.yaml`](values-studio-prod.yaml) (placeholders):

```bash
helm install studio deploy/helm/studio \
  -n studio --create-namespace -f selfhost/production/values-studio-prod.yaml
```

- **Autoscaling** is on for the API front-door and the worker (the worker
  dequeues agent/automation runs — it is required, not optional).

### Secrets — with OR without External Secrets Operator

Two supported paths (never inline secret material in git):

- **With ESO** — `externalSecret.enabled=true` + `secretPath` + `secretStoreName`;
  the chart renders an ExternalSecret that syncs from your store.
- **Without ESO** (common) — create a plain Secret yourself and set
  `secret.secretName`; the chart injects every key via `envFrom`:

  ```bash
  kubectl -n studio create secret generic studio-prod-secrets \
    --from-literal=BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
    --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 32)" \
    --from-literal=S3_ACCESS_KEY_ID="<key>" \
    --from-literal=S3_SECRET_ACCESS_KEY="<secret>" \
    --from-literal=DATABASE_URL="postgresql://user:pass@host:5432/studio" \
    --from-literal=STUDIO_SANDBOX_SENTINEL_TOKEN="$(openssl rand -hex 32)"   # sandbox only
  ```

`BETTER_AUTH_SECRET` + `ENCRYPTION_KEY` MUST be stable across restarts; the
sentinel token MUST equal `sandbox-env.sentinel.token`.

### Ingress — the chart renders none; expose with what you have

Studio's Service is `ClusterIP:80`. Pick the least-effort option for your cluster:

1. **You already run an ingress controller** (nginx/Traefik/ALB) → create an
   Ingress routing your host to Service `studio`:80 with your `ingressClassName`
   + TLS (cert-manager or the controller's).
2. **Cloud, no controller** → `service.type=LoadBalancer`, then point DNS + TLS
   at the LB.
3. **Istio / Gateway API** → a Gateway + HTTPRoute to the Service (same shape as
   the sandbox preview gateway).

Set `BASE_URL` / `BETTER_AUTH_URL` to the public `https://` URL either way.

## Sandbox (code-execution + previews)

The hardened sandbox posture ships in the `sandbox-env` chart; see
[`values-sandbox-env-prod.yaml`](values-sandbox-env-prod.yaml) for the knobs:

- **Egress lockdown** (`netinit`): an iptables init container REJECTs
  in-cluster/link-local CIDRs and allows only 443 + 53 — untrusted sandbox code
  can't reach your Services. This is the sandbox's outbound firewall.
- **Node isolation:** pin sandbox pods to a dedicated tainted NodePool so an
  escape lands away from Studio/Postgres/NATS.
- **Zone spread**, **warm pool** (+ optional HPA), and a **sentinel token**.
- **Preview URLs:** wildcard `*.<domain>` via an Istio Gateway + cert-manager
  (needs Gateway API CRDs + a DNS-01 issuer). Locally this is replaced by the
  in-process Studio proxy on `:80`.

Install the operator first (once per cluster, into `agent-sandbox-system`), then
`sandbox-env`:

```bash
helm install agent-sandbox deploy/helm/sandbox-operator \
  -n agent-sandbox-system --create-namespace
helm install sandbox-env-prod deploy/helm/sandbox-env \
  -n agent-sandbox-system -f selfhost/production/values-sandbox-env-prod.yaml
```

Then wire Studio: `STUDIO_AGENT_SANDBOX_ENABLED=true`, `STUDIO_ENV=<env>`,
`STUDIO_SANDBOX_TEMPLATE_NAME=studio-sandbox-<env>`, and the preview URL
pattern pointing at your wildcard domain.

See the top-level [`selfhost/README.md`](../README.md) for the full model.
