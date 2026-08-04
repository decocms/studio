# @decocms/harness-runner

Runs coding-agent harnesses inside a sandbox pod. One process per run: the Go
daemon execs it, writes `{harnessId, input}` to stdin, and reads one
`HarnessRunResult` (`{chunks, error}`) off stdout. stderr is the pod's log.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/harness-runner` (`packages/harness-runner`) |
| Kind | Private in-sandbox harness process |
| Runtime | Bun (inside the sandbox image) |
| Distribution | Packed into `packages/sandbox/dist/harness-runner.tgz` and installed into the sandbox image |

The wire is defined by `daemon-go/internal/dispatch/runner.go`; the result shape
is `harnessRunResultSchema` in `packages/sandbox/dispatch/schemas.ts`. It
implements one harness today, `claude-code`.

- `main.ts` — the wire: stdin envelope in, one result out.
- `claude-code.ts` — SDK options policy, the per-turn loop, session persistence.
- `to-ui-chunks.ts` — SDK messages → AI SDK `UIMessageChunk`s.

Model access is configured entirely by environment, pushed down as sandbox env
by Studio and reaching this process as its spawn environment:

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic direct |
| `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` | OpenRouter's Anthropic-compatible endpoint |
| `CLAUDE_CODE_MODEL` | Optional model pin; unset uses Claude Code's default |
| `CLAUDE_CODE_PATH` | Optional explicit path to the `claude` executable |
| `CLAUDE_CONFIG_DIR` | Claude Code's config dir; also where the per-thread session id is remembered |

## Boundaries

- The daemon owns the workspace. This package never clones, installs, or starts
  a dev server — it only runs a harness in a checkout that already exists.
- Always print a result, even on a harness throw: a process that prints nothing
  is a crash to the daemon, and a crash mid-turn must still surface its partial
  chunks plus an `error`.
- Only type-level imports from `@decocms/sandbox` — the dispatch schemas are the
  shared wire contract, and this package must stay runtime-independent of
  Studio's tree so the image installs it standalone.
- Permissions are bypassed by design: the pod is the isolation boundary and
  there is no approval UI upstream. Do not add a prompt path that would block a
  run forever.

```bash
bun run --cwd=packages/harness-runner check
bun run --cwd=packages/harness-runner test
```

## Related documentation

- [Sandbox package](../sandbox/README.md)
- [Run attachment and dispatch lifecycle](../sandbox/run-attachment.md)
- [Repository guidelines](../../AGENTS.md)
