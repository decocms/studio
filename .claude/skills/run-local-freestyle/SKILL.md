---
name: run-local-freestyle
description: Run Studio locally with chats and task runs executing in real Freestyle sandboxes, reachable through an ngrok tunnel. Use when asked to "run locally with Freestyle", "test claude-code chats locally", "run the sandbox harness end to end", or to try daemon/harness-runner changes in a real sandbox.
---

# Run Studio locally on Freestyle

Freestyle VMs call back into Studio (the `studio` MCP, org-fs), so a local Studio needs a public URL. The browser must use that same URL: auth trusts only `BASE_URL`.

## Prerequisites

- `FREESTYLE_API_KEY` in the repo-root `.env`.
- `ngrok` with an auth token (`ngrok config add-authtoken <token>`).
- Docker with `buildx` and Go, only if you changed `packages/sandbox/daemon-go` or `packages/harness-runner`.

## 1. Tunnel

```bash
ngrok http 4000
URL=$(curl -s localhost:4040/api/tunnels | grep -o '"public_url":"https[^"]*' | cut -d'"' -f4)
```

- Use ngrok. Do not use a cloudflared quick tunnel: it buffers server-sent events until the stream closes, so chat output never streams and queued messages look stuck.
- Point the tunnel at Vite (4000), not the API (3000). Vite proxies `/api`.

## 2. Start Studio

`bun run dev` is `docker compose up --build --watch`, and compose passes no host
environment into the containers. Put the tunnel settings in an override file
outside the repository (here `$TMPDIR`); compose fills `${FREESTYLE_API_KEY}`
from the repo-root `.env`, so the key never lands in the file:

```bash
cat > $TMPDIR/compose.freestyle.yaml <<EOF
services:
  api:
    environment:
      BASE_URL: $URL
      BETTER_AUTH_URL: $URL
      STUDIO_PUBLIC_URL: $URL
      MESH_PUBLIC_URL: $URL
      KUBECONFIG: /dev/null
      STUDIO_AGENT_SANDBOX_ENABLED: "true"
      STUDIO_SANDBOX_FREESTYLE_SHARE: "1"
      FREESTYLE_API_KEY: \${FREESTYLE_API_KEY}
  web:
    environment:
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: .${URL#*.}
EOF
docker compose -f compose.yaml -f $TMPDIR/compose.freestyle.yaml build api
docker compose -f compose.yaml -f $TMPDIR/compose.freestyle.yaml up --watch
```

- Build once before `up`. `api`, `web` and `migrate` share one image tag, and building them in parallel fails with `image "studio-dev:<project>" already exists`.
- The allowed host is the tunnel's parent domain: ngrok's free URLs are `*.ngrok-free.dev` (older accounts get `*.ngrok-free.app`).
- Always set `KUBECONFIG=/dev/null`. Without it the Kubernetes provider is built from your default context, and a Freestyle fallback could provision there.
- Always override `STUDIO_PUBLIC_URL` and `MESH_PUBLIC_URL`. A stale value in `.env` wins over `BASE_URL` for minted MCP URLs, and runs fail with `studio MCP is unusable`.
- Open `$URL` in the browser and log in there, not on `localhost`. Click through ngrok's one-time warning page.
- If you change the tunnel URL, restart Studio with the new one.

## 3. Sandbox image (only for daemon or runner changes)

Freestyle runs `ghcr.io/decocms/studio/studio-sandbox-go:<packages/sandbox version>` by default. To run local daemon or runner code, overlay it on that image:

```bash
O=$(mktemp -d); mkdir $O/runner
(cd packages/sandbox/daemon-go && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o $O/daemon-go .)
cp packages/harness-runner/package.json $O/runner/
for f in packages/harness-runner/*.ts; do [[ $f == *.test.ts ]] || cp "$f" $O/runner/; done
cat > $O/Dockerfile <<'EOF'
FROM ghcr.io/decocms/studio/studio-sandbox-go:<version>
COPY --chown=sandbox:sandbox daemon-go /opt/sandbox-daemon/daemon-go
COPY --chown=sandbox:sandbox --chmod=755 runner/ /usr/local/lib/node_modules/@decocms/harness-runner/
EOF
TAG=ttl.sh/studio-sandbox-$(uuidgen | tr A-Z a-z | cut -c1-12):24h
docker buildx build --platform linux/amd64 -t $TAG --load $O && docker push $TAG
```

Then add `STUDIO_SANDBOX_FREESTYLE_IMAGE=$TAG` to the start command.

- Do not build `packages/sandbox/image/Dockerfile` for amd64 on Apple Silicon. Chromium and the Claude Code CLI crash under QEMU.
- Keep `--chmod=755` on the runner copy. `main.ts` is the bin target, and without the execute bit runs fail with `executable file not found in $PATH`.
- Use a new tag for every rebuild. The base snapshot is keyed by the image name, so a reused tag keeps serving the old snapshot.
- Copy every file listed in `packages/harness-runner/package.json` `files`, and rebuild the base image instead if the runner's dependencies changed.

## 4. Pre-build the base snapshot

The first sandbox for an image builds a base snapshot (about 2 minutes). Build it before you chat:

```bash
cd packages/sandbox && bun --env-file=../../.env -e '
const { FreestyleSandboxProvider } = await import("./server/provider/freestyle.ts");
const p = new FreestyleSandboxProvider({ apiKey: process.env.FREESTYLE_API_KEY, image: process.env.IMAGE });
await p.warm(); p.close(); process.exit(0)'
```

Set `IMAGE` to the image Studio runs (your `$TAG`, or the default above).

## 5. Run chats on claude-code

Turn on **Settings → General → Code Agents → "Run every chat with Claude Code in its own sandbox"** (`chat_harness_sandbox_only`). A chat that already has a sandbox keeps its image; start a new chat after changing images.

## Debugging

- **Studio log:** `[sandbox-dispatch] run ended` reports chunks, duration and the harness error.
- **Local database:** `postgresql://postgres:postgres@localhost:<port>/postgres`, with the port from the `System Database URL` line in the dev log. Read stored parts from `thread_message_parts`.
- **Claude Code's MCP log** for a run: it lives inside the sandbox container at `$HOME/.cache/claude-cli-nodejs/*/mcp-logs-studio/*.jsonl`. Reach it with the Freestyle SDK: look the VM up by slug (the sandbox handle), then exec `docker exec sandbox …`.
- Claude Code aborts an MCP call 90 seconds after any transport error on that server ("transport dropped mid-call", about 2 minutes total). Find the first error in its MCP log.

## Clean up

Stop compose (`docker compose -f compose.yaml -f $TMPDIR/compose.freestyle.yaml down`) and ngrok. Freestyle VMs pause after 5 minutes idle and are deleted after a day; `ttl.sh` images expire with their tag.
