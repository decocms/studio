# Contributing to Studio

Thanks for contributing. This is the short list of things that will save you
(and reviewers) time. Architecture, commands, and coding conventions live in
[`AGENTS.md`](./AGENTS.md) (symlinked as `CLAUDE.md`); testing philosophy in
[`TESTING.md`](./TESTING.md). This file is the human-facing quick start plus the
rules that bite hardest if ignored.

## The golden rules

### 1. Watch out for synchronous / blocking operations — especially in the sandbox daemon

The sandbox daemon (`packages/sandbox/daemon/**`) runs on a **single-threaded
Bun event loop**. Anything synchronous or CPU-bound holds that one thread and
**blocks the loop**:

- sync fs — `readFileSync`, `writeFileSync`, `mkdirSync`, `readdirSync`, …
- sync crypto / hashing, `execSync`, `child_process` sync variants
- CPU-bound work — large `JSON.parse` / `JSON.stringify`, unbounded loops,
  synchronous compression, big regex over big strings

Why it's worse than "a bit slow": Studio continuously polls the daemon's HTTP
health probe. When the loop is blocked, the probe doesn't answer, and Studio
concludes the sandbox is **dead** — then it does crazy shit: marks the run
crashed, tears the pod down, triggers recovery. A single missed probe can flip
a perfectly healthy sandbox to "crashed". So a blocking write you thought was
harmless can kill a user's live session.

**Do instead:** use `node:fs/promises` and `await`; run independent I/O with
`Promise.all`; stream or chunk large payloads; offload CPU-bound work off the
hot path. If you must do something synchronous, prove it's bounded and tiny,
and leave a comment saying so.

This applies most sharply to the daemon, but "prefer async, never block the
loop" is the default everywhere in the codebase.

### 2. Never hand-roll async primitives

Use `@decocms/std` for `sleep`, `retry`, and backoff. Do not write another
`setTimeout` promise, retry loop, or `Math.min(base * 2 ** n, cap)` jitter
formula. See the "Async primitives" section in [`AGENTS.md`](./AGENTS.md).

### 3. Tools go through `StudioContext`

Never touch env vars, HTTP objects, or the DB driver directly from a tool — all
dependencies flow through `StudioContext`. Use `defineTool()`. See
[`AGENTS.md`](./AGENTS.md).

### 4. Don't silence the tooling

Don't edit `knip.json` to hide dead-code warnings, don't disable lints to make
them pass, don't `@ts-ignore` a real type error. Fix the underlying thing.

## Getting started

Prerequisites: [Bun](https://bun.sh).

```bash
bun install
npx lefthook install   # pre-commit hook that runs `bun run fmt`
bun run dev            # migrations + client + server
```

## Before you push

Run these locally — CI runs them and CI failures are always on your branch:

```bash
bun run check   # TypeScript, all workspaces
bun run lint    # oxlint + custom plugins
bun run fmt     # Biome (also enforced by the pre-commit hook)
bun test        # unit tests
```

## Testing

Two tiers, no third — see [`TESTING.md`](./TESTING.md) for the full rules:

- **Unit (`bun test`)** — pure logic only. No mocks, no DB, no network.
  Co-located `*.test.ts` next to the source.
- **E2E (Playwright, `packages/e2e`)** — everything else. Real Postgres + NATS.

The sandbox daemon has its own black-box e2e (`packages/sandbox/daemon/*.e2e.test.ts`):
spawn the built daemon, assert over HTTP + the workspace filesystem. Mirror
that pattern for new daemon routes.

If a test needs `vi.mock`, a stubbed `StudioContext`, or a fake `fetch`, it is
not a unit test — move it to e2e.

## Commits & pull requests

- **Conventional commits**: `type(scope): message` (e.g.
  `fix(event-bus): handle retry-after flow`). Chores: `[chore]: ...`.
- Keep PRs focused. Stack dependent PRs rather than bundling unrelated changes.
- A PR should say what changed, how it was tested, and call out follow-ups.
- Comments: explain *why*, not *what*. No narration, no paragraph essays.
  Prefer deleting code over adding it.

## License

Sustainable Use License — see [`LICENSE.md`](./LICENSE.md). Free to self-host
for internal use and for client projects; a commercial license is required for
SaaS / revenue-generating production systems. Questions: contact@decocms.com.
