# Local Studio via Docker Compose

The easiest self-host path: Studio + PostgreSQL + NATS + MinIO as containers, all
wired — Studio provisions nothing itself. This folder is the *experience* around
the canonical stack: [`compose.yaml`](compose.yaml) `include`s
[`deploy/docker-compose/docker-compose.postgres.yml`](../../../deploy/docker-compose/docker-compose.postgres.yml)
(it does not duplicate it) and pairs it with [`.env.example`](.env.example).

```bash
cp selfhost/examples/docker-compose/.env.example selfhost/examples/docker-compose/.env
docker compose -f selfhost/examples/docker-compose/compose.yaml up
open http://localhost:3000        # sign up — first user becomes org owner
```

- An empty `.env` already boots (every knob has a dev default). Set real
  `BETTER_AUTH_SECRET` / `ENCRYPTION_KEY` for anything shared — both must stay
  stable across restarts.
- All images are multi-arch (native on Apple Silicon).
- Tear down: `docker compose -f selfhost/examples/docker-compose/compose.yaml down`
  (add `-v` to drop the Postgres/MinIO volumes too).

For a real cluster, see the [k8s-local umbrella](../k8s-local/); for production,
see [`selfhost/production/`](../../production/).
