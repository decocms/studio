# Studio

Studio is an open-source control plane for Model Context Protocol (MCP) traffic. It provides a unified layer for authentication, routing, and observability between MCP clients (Cursor, Claude, VS Code) and MCP servers. The system is built as a monorepo using Bun workspaces with TypeScript, Hono (API), and React 19 (UI).

## Before changing code

Read the guidance for each area your change touches, including when working
from the repository root:

| When changing | Read first |
| --- | --- |
| API tools, routes, storage, or realtime delivery | [apps/api/AGENTS.md](apps/api/AGENTS.md) |
| Web UI, localization, or experiments | [apps/web/AGENTS.md](apps/web/AGENTS.md) |
| Native app, signing, or credential storage | [apps/native/AGENTS.md](apps/native/AGENTS.md) |
| Shared contracts, organization flags, or async utilities | [packages/shared/AGENTS.md](packages/shared/AGENTS.md) |
| Sandbox provisioning, dispatch, caching, or daemon | [packages/sandbox/AGENTS.md](packages/sandbox/AGENTS.md) |
| Lint rules, lint configuration, or oxlint version | [plugins/AGENTS.md](plugins/AGENTS.md) |
| MCP bindings | [packages/bindings/README.md](packages/bindings/README.md) |
| Tests | [TESTING.md](TESTING.md); for E2E, also [packages/e2e/README.md](packages/e2e/README.md) |

## Working locally

Use `bun run dev` for the API and web app. Workspace READMEs own setup and
build instructions. [CONTRIBUTING.md](CONTRIBUTING.md) covers initial setup,
Git hooks, and the contribution workflow.

Before pushing, run `bun run verify` and include any formatting changes in
the commit. CI runs the broader checks. Run focused integration or E2E tests
when the changed behavior needs them, following `TESTING.md`.

Investigate failing checks. Before calling a failure pre-existing, reproduce
it on the base revision or provide equivalent evidence. Report what passed,
what failed, and what was not run.

## Shared decisions

- Use `@decocms/shared/std` for sleep, retry, and backoff across runtimes.
  Extend the existing utilities when necessary; the circuit breaker is a
  separate fault-isolation mechanism.
- Deliver state changes through the existing push paths. Keep the idle poll
  as a fallback; shortening it is not a fix for staleness. Read the API
  instructions before adding a producer or consumer.
- Keep authorization and data access scoped to the current principal and
  organization. Feature flags gate product behavior, not access.
- Use `thread` in domain identifiers, storage, and wire contracts. User-facing
  text calls it a "chat". `Chat` and `ChatLayout` may name UI composition;
  their domain state still uses `threadId` and thread contracts.
- Validate external input with schemas. Narrow unions with discriminants or
  property checks instead of casting away uncertainty.
- Fix underlying type, lint, and unused-code findings. Do not add exclusions
  or weaken checks just to make a change pass. Remove code and exports your
  change makes unused.
- Keep comments focused on reasons the code cannot express. Simplify a
  workaround before adding a long explanation for it.

## Check the behavior you changed

- Cover relevant empty, invalid, duplicate, and oversized inputs and schema
  variants. Update tests that assert the old behavior, including contracts
  shared across test suites.
- Trace overlapping operations: what happens to an earlier operation's output
  when another starts? Retry side effects only when idempotent. Claim work at
  dispatch and coordinate writes that share a destination.
- Complete the lifecycle of persisted state. Include update and deletion,
  clean up with the parent, and clear prior terminal state when restarting.
- Keep cache and list keys distinct across tenants and entity shapes. Bound
  caches with a TTL and size cap, invalidate bad entries, and publish only
  after a health signal.
- Changes on boot, install, or dispatch hot paths need their own default-off
  flag. Keep rollout separate from deployment; do not reuse an unrelated flag.
- Include relevant verification and migration notes in PRs. For UI changes,
  upload screenshots or videos as GitHub attachments and embed their asset
  URLs in the PR body. Never commit PR-only evidence to the repository,
  including `.github/screenshots/` or `.github/pr-assets/`. Follow the
  [PR template](.github/pull_request_template.md).

## Credentials and shared artifacts

Keep real credentials and customer identifiers out of source, fixtures, logs,
PRs, and other shared artifacts. Use synthetic examples. Redact secrets before
quoting debugging output.

Strip embedded credentials at the persistence boundary and fail closed if a
value cannot be parsed safely. Test the written artifact's bytes, not only an
intermediate object. Treat pushed credentials as exposed: rotate them first;
rewriting Git history does not revoke them.

## Documentation

`apps/docs/` describes intended system behavior and architecture. When code
differs, preserve the specification and identify the implementation gap.

Keep each instruction in one place. Put task-specific guidance near its owner
and link to it here with a condition for reading it. Let code, schemas, and
tool configuration own discoverable implementation details. When a decision
changes, update its existing explanation instead of appending a correction.

Before changing a workspace README, read the README requirements in
[CONTRIBUTING.md](CONTRIBUTING.md#workspace-readmes).
