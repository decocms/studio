# chart-deco-studio-previews

Control plane for per-PR preview environments. Deploys no workload of its own:
it renders an Argo CD `ApplicationSet` and the shared wildcard `Gateway` that
per-PR routes attach to.

Label a pull request and the generator produces an Application that installs
`chart-deco-studio` into its own namespace. Close the PR, drop the label, or let
the TTL expire it, and the Application disappears on the next poll — namespace,
Postgres pod and all.

## Requirements

- Argo CD, with the ApplicationSet controller running.
- Gateway API and a `GatewayClass` (the defaults assume Istio).
- A published `chart-deco-studio` **>= 0.14.0** reachable from the cluster.
- A token with `pull_requests: read`, in a Secret in the Argo CD namespace.
- The application repository's own preview-build workflow, publishing images
  tagged `<prefix>-<pr number>-<7-char head sha>`.

## Why this is a separate chart

`chart-deco-studio` is installed by people self-hosting Studio. It must not
carry an `argoproj.io` CRD that a plain `helm install` cannot resolve, and a
preview release must never be able to render the ApplicationSet that generates
previews — that recursion is impossible here by construction rather than by
validation. Preview policy also changes on a different cadence than the
application: publishing `chart-deco-studio` dispatches a chart bump downstream,
so a change to poll interval or label would otherwise roll production.

## Configuration

Every value that names an organisation, repository, domain or cloud account is
empty by default and required at install time; `templates/validations.yaml`
fails the render on anything missing. See `values.yaml` — the two blocks that
matter are `applicationSet` (what to watch) and `studioValues` (what to pass
through to each generated preview).

## The tag contract

`images.tagPrefix` plus the PR number plus the first 7 characters of
`.head_sha` must equal what the build workflow publishes. This is asserted in
`.github/workflows/helm-test.yml`, which is the reason this chart lives in the
same repository as that workflow: a `pull_request` checkout lands on
`refs/pull/N/merge`, and tagging from *that* commit produces an image the
generator can never ask for.

## Known gaps

- The listener is plain HTTP behind load-balancer TLS termination. Terminating
  at the Gateway instead would need a certificate per host, which means an
  issuance per PR.
- Nothing here authenticates the preview URL. Put an authorization policy on
  the listener before pointing it at a public domain: a preview accepts
  email/password signup and can drive LLM agents.
