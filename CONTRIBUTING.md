# Contributing to Studio

Thanks for contributing. This is the quick start plus the handful of rules that
save the most review time. Architecture, commands, and coding conventions live
in [`AGENTS.md`](./AGENTS.md) (symlinked as `CLAUDE.md`); testing philosophy in
[`TESTING.md`](./TESTING.md).

## Getting started

Prerequisites: [Bun](https://bun.sh) and Node ≥ 24.

```bash
bun install
npx lefthook install   # pre-commit hook that runs `bun run fmt`
bun run dev            # migrations + web app + API
```

### Importing a GitHub repository locally

Install [GitHub CLI](https://cli.github.com/) and run
`gh auth login --hostname github.com`. In local mode, open **Add account** in
the repository picker or Settings → Repositories, then choose
**Connect with GitHub CLI**. Connect, then
choose a repository to import. No GitHub App registration or OAuth secrets are
needed. `bun run dev` enables local mode by default; `--no-local-mode` uses the
GitHub App connection instead.

Studio runs `gh` on the machine running the API. It saves the selected account
identity and reads its token from the CLI when needed, without storing the
token in Studio's database. Switching the active account in `gh` does not
switch an existing connection. After logging out or renaming your GitHub
account, log in again and reconnect in Studio.

The connection uses the developer's CLI permissions, which can cover more
repositories than the one imported. GitHub App installation and webhook flows
still require an App. Run the API on your host to use your host's CLI login;
a container cannot automatically access it.

## Filing issues & opening PRs

- **Bug or feature idea?** Open an issue first — templates live under
  [`.github/ISSUE_TEMPLATE`](./.github/ISSUE_TEMPLATE). For anything large,
  agree on the approach in the issue before writing code.
- **Fork or branch** off `main`, then open a PR. The
  [PR template](./.github/pull_request_template.md) tells you what to fill in:
  what changed, how to test it, and any migration notes.
- Keep PRs focused. Stack dependent PRs rather than bundling unrelated changes.

### Preview environments

Add the **`preview`** label to a PR and a throwaway Studio is deployed at
`https://pr-<n>.pr.studio.decocms.com`. A bot comment carries the link and
updates itself as the build progresses; expect ~10 minutes on a fresh preview.
Each preview runs its own Postgres, so the database is empty — sign up with any
email and password.

Previews are **short-lived on purpose**: they expire 48h after their last
deploy, and removing the label (or closing the PR) tears one down immediately.
Pushing to the PR, or re-adding the label, resets the clock. Nothing in a
preview survives, so never put anything you need in one.

Previews deliberately do **not** cover hosted agent sandboxes, OAuth sign-in,
billing, monitoring, or multi-pod behaviour — a green preview says nothing
about any of those. See [`deploy/preview/README.md`](./deploy/preview/README.md)
for the full list and for troubleshooting.

## The rules that bite hardest

### 1. Tools go through `StudioContext`

Never touch env vars, HTTP objects, or the DB driver directly from a tool — all
dependencies flow through `StudioContext`. Use `defineTool()`. See
[`AGENTS.md`](./AGENTS.md).

### 2. Never hand-roll async primitives

Use `@decocms/shared/std` for `sleep`, `retry`, and backoff. Don't write another
`setTimeout` promise, retry loop, or `Math.min(base * 2 ** n, cap)` jitter
formula. See the "Async primitives" section in [`AGENTS.md`](./AGENTS.md).

### 3. Don't silence the tooling

Don't edit `knip.json` to hide dead-code warnings, don't disable lints to make
them pass, don't `@ts-ignore` a real type error. Fix the underlying thing.

### 4. Never block the event loop

Studio's API is a single-threaded Bun process: sync fs (`readFileSync`,
`mkdirSync`, …), sync crypto / `execSync`, or CPU-bound work (large
`JSON.parse` / `JSON.stringify`, unbounded loops) freezes it and stalls every
in-flight request. Use `node:fs/promises` with `await`, stream large payloads,
and keep CPU work off the hot path.

The sandbox daemon (`packages/sandbox/daemon-go/**`) is Go, so its handlers are
goroutines rather than one loop — but the health contract is unforgiving in the
same way: Studio polls the daemon's probe and a **single** missed probe flips a
healthy sandbox to "crashed", tearing the pod down mid-session. Don't hold a
lock across slow I/O on the probe path.

### 5. Keep workspace READMEs useful

Every direct child of `apps/` and `packages/` has a `README.md`. These files use
the same core section order: **Overview**, **Responsibilities**, **Usage**,
**Architecture**, **Development**, **Boundaries**, and **Related
documentation**. A short metadata table identifies the workspace, kind,
runtime, and distribution model.

Write in clear English, active voice, and present tense. Use the current Studio,
API, and web terminology; keep commands runnable from the repository root; and
verify links, import paths, and scripts against the implementation. Add
domain-specific sections when they communicate real protocol, security, or
operational constraints—not generic boilerplate.

Run `bun run check:readmes` after changing a workspace README. The check also
runs as part of `bun run check`.

## Before you push

Run these locally — CI runs them, and CI failures are always on your branch:

```bash
bun run check   # TypeScript, all workspaces
bun run lint    # oxlint + custom plugins
bun run fmt     # Biome (also enforced by the pre-commit hook)
bun run test    # unit tests
```

## Testing

Two tiers, no third — see [`TESTING.md`](./TESTING.md) for the full rules:

- **Unit (`bun run test`)** — pure logic only. No mocks, no DB, no network.
  Co-located `*.test.ts` next to the source.
- **E2E (Playwright, `packages/e2e`)** — everything else. Real Postgres + NATS.

If a test needs `vi.mock`, a stubbed `StudioContext`, or a fake `fetch`, it is
not a unit test — move it to e2e.

## Commits

- **Conventional commits**: `type(scope): message` (e.g.
  `fix(event-bus): handle retry-after flow`). Chores: `[chore]: ...`.
- Comments explain *why*, not *what*. Prefer deleting code over adding it.

## License

MIT — see [`LICENSE.md`](./LICENSE.md).
