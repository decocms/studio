# Dev-hybrid: source development against local Kubernetes

Run the API and Vite on your host with hot reload while PostgreSQL, NATS,
MinIO, and the agent-sandbox operator run in the local Kubernetes cluster.
Use this for sandbox, preview, and operator changes. For app-only work, use
`docker compose up --build --watch` from the repository root.

## Run

Install Bun, Docker, kubectl, and Helm, then run:

```bash
./selfhost/examples/dev-hybrid/dev-hybrid.sh
# open http://localhost:4000
```

The script starts the local cluster if needed, scales the in-cluster Studio
app and worker to zero, and port-forwards the backend Services. It installs
workspace dependencies if missing, applies application and DBOS migrations,
builds sandbox packages, and starts the host API and Vite directly. Ctrl-C
stops its processes and restores the in-cluster app and worker.

The default Compose development environment does not include the Kubernetes
sandbox operator. This workflow uses your kubeconfig and API-server
port-forwards to provision and reach sandboxes.

## Configuration

On first run, the script copies [`.env.example`](.env.example) to a git-ignored
`.env` in this directory. Edit it for backend URLs, app secrets, the sandbox
provider/template, and the sentinel token matching the local umbrella chart.
It exports those values before starting the API; no CLI provisions services.

If a forwarded port is busy, change `DB_PORT`, `NATS_PORT`, or `MINIO_PORT`
and the matching URL in this `.env`. If changing `VITE_PORT`, also update
`BASE_URL`, `BETTER_AUTH_URL`, and the preview pattern. The checked-in secrets
are local fixtures; replace them before sharing an environment.

## Schema ownership

The source checkout owns migration execution for this workflow. A migration
failure stops startup; resolve version skew before running the app. For a
throwaway local database that can be deleted and recreated:

```bash
RESET_DB=1 ./selfhost/examples/dev-hybrid/dev-hybrid.sh
```

This deletes the cluster's Studio database, including users and organizations.

## Limitations

- Preview routing is best-effort: the default pattern is
  `http://{handle}.preview.localhost:4000`. Use the full local Kubernetes
  deployment when testing its nginx/Gateway routing.
- Monitoring defaults to local DuckDB/NDJSON. Set `CLICKHOUSE_URL` in this
  workflow's `.env` to use a cluster endpoint instead.
- Restoring the in-cluster deployment assumes one app and one worker replica.
