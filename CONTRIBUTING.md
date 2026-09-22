# Contributing to Studio

Read [AGENTS.md](AGENTS.md) for repository-wide decisions and links to
scoped instructions. This guide covers setup and contributions.

## Getting started

Prerequisites: [Bun](https://bun.sh) and Node ≥ 24.

```bash
bun install
npx lefthook install   # staged-file checks from lefthook.yml
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

## Workspace READMEs

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

## Verification

Follow the [local verification instructions](AGENTS.md#working-locally).
Before writing or changing tests, read [TESTING.md](TESTING.md).

## Commits

- **Conventional commits**: `type(scope): message` (e.g.
  `fix(notifications): prevent duplicate digest emails`). Chores: `[chore]: ...`.

## License

MIT — see [`LICENSE.md`](./LICENSE.md).
