# Native Git worktree ref resolution — implementation plan

**Status:** implemented and verified in the isolated worktree.

## Goal

Make desktop sandbox acquisition create a local worktree reliably when the
requested branch does not exist on the remote, regardless of the installed Git
version's human-readable error wording.

The observable contract stays the same:

1. Use the requested remote branch when it exists.
2. Otherwise create the requested local branch from the locally recorded
   `origin/HEAD`, repairing a missing or dangling value from the remote's
   advertised default.
3. Only use Git's no-start-point/orphan behavior when the remote-tracking
   branch namespace contains no commit.

## Pre-fix state

`setup/clone.rs` acquires repository content in two layers:

- `sync_canonical` creates or fetches one shared canonical checkout per remote.
- `add_worktree` creates the branch-specific working tree used by a sandbox.

Before this fix, a named branch made `add_worktree` try these start points in
order:

| Attempt | Start point | Intended result |
| --- | --- | --- |
| 1 | `refs/remotes/origin/<requested>` | Reuse an existing remote branch. |
| 2 | `refs/remotes/origin/HEAD` | Fork a new local branch from the remote default. |
| 3 | none | Let Git create an orphan branch for an empty remote. |

The candidate order was correct, but moving from one candidate to the next was
decided by parsing `git worktree add` stderr. `start_point_unresolvable()` only
recognized the phrases `invalid reference` and `unknown revision`.

At planning time, the test suite already exercised:

- a requested branch that exists remotely;
- a requested branch that must be created from the default branch;
- a genuinely empty remote that needs an orphan worktree;
- the canonical checkout holding the requested default branch;
- stale worktree registration pruning and interrupted-clone recovery.

There was no focused sibling-worktree collision regression in this module. The
implementation adds one while preserving that pre-existing recovery branch.

Those pre-fix tests invoked whichever Git binary was installed on the test
host. They therefore proved behavior for that one Git version, not for every
stable stderr variant produced by Git versions installed on users' machines.

## Observed failure

The Linux support bundle showed two acquisitions with the same shape:

1. `git clone` or `git fetch --prune origin` completed successfully.
2. The requested remote branch was absent.
3. `origin/HEAD` existed and resolved to the repository's default branch.
4. `git worktree add ... refs/remotes/origin/<requested>` exited nonzero with
   `fatal: Not a valid object name`.
5. `start_point_unresolvable()` did not recognize that Git-version-specific
   phrase, so `add_worktree` returned immediately instead of trying
   `origin/HEAD`.

`SandboxManager::ensure` then reduced the failure to a sanitized generic
clone/checkout error. That protects credential-bearing clone URLs from being
copied into registry state, but its credentials-oriented guidance obscured the
actual branch-resolution failure.

This is not a clone, authentication, PATH-repair, WebKit, or Secret Service
failure. It is a portability bug in how Studio infers ref existence from
human-readable Git stderr. Pinning `LC_ALL=C` prevents localization but cannot
make wording identical across Git versions.

## Invariants

The fix must preserve all of these:

- Ref existence is determined through a stable Git plumbing command, never by
  matching human-readable stderr.
- A successful remote ref resolution produces an immutable commit object ID;
  `worktree add` uses that ID so a concurrent fetch/prune cannot change or
  delete the selected ref between resolution and worktree creation.
- The requested branch still tracks `origin/<requested>`, including when it was
  created from `origin/HEAD` rather than from an existing same-named remote ref.
- A missing or dangling `origin/HEAD` gets one `git remote set-head origin -a`
  repair attempt before the empty-remote fallback.
- No-start-point/orphan creation is allowed only after proving the remote-
  tracking namespace has no commit. A nonempty remote with no advertised
  default head fails with actionable guidance instead of silently producing an
  unrelated empty branch.
- A Git command failure other than “ref is absent” remains a hard failure; it
  must not be silently widened into a different start point.
- Cancellation and shutdown continue to own every spawned Git process through
  the existing `ProcessController` and task registry.
- Existing canonical and sibling worktree-collision handling remains intact.
  This change is about start-point resolution, not branch ownership between
  live worktrees.
- Logs and persisted errors must not add raw clone URLs, tokens, or credentials.

## Proposed implementation

### P0 — Resolve refs structurally

Add a private helper beside `add_worktree` that resolves one candidate ref to
an optional commit object ID using the existing streamed `run_git` path:

```text
git rev-parse --verify --quiet <ref>^{commit}
```

Interpret the command as a typed result:

- exit `0` plus one full hexadecimal object ID on stdout → `Some(oid)`;
- exit `1` → confirm the exact ref with
  `git show-ref --verify --quiet -- <ref>`;
  - `show-ref` exit `1` means the ref is missing or dangling → `None`;
  - `show-ref` exit `0` means the ref exists but cannot peel to a commit →
    `Err`;
  - any other `show-ref` exit → `Err`;
- any other `rev-parse` exit, cancellation, malformed success output, or spawn
  failure → `Err` with a sanitized command failure.

The second structural probe matters for dangling symbolic refs: some Git
versions emit a warning while returning exit `1`. It also prevents a blob-valued
or corrupt existing ref from being mistaken for an absent branch, without
matching either message.

The object-ID parser must accept both SHA-1 and SHA-256 repositories rather
than assuming a 40-character hash. It should accept exactly one 40- or
64-character ASCII-hex token and fail closed on any other successful output.

`run_git` represents a requested signal as an exit code, including cancellation
before spawn. The resolver must check `controller.requested()` before treating
exit `1` as “absent”. Apply the same check after the best-effort `remote
set-head` call so shutdown can never be misclassified as a missing ref.

The branch name has already passed `is_valid_remote_branch_name`, and the
helper constructs the full `refs/remotes/origin/...` namespace itself. No
caller-provided option-like argv is introduced.

### P1 — Select one immutable start point

Replace the candidate `worktree add`/stderr-classification loop with explicit
selection:

1. Resolve `refs/remotes/origin/<requested>`; use its OID when present.
2. If absent, resolve `refs/remotes/origin/HEAD`.
3. If `origin/HEAD` is absent, run `git remote set-head origin -a` once and
   resolve it again.
4. If no commit resolves, run
   `git rev-list --max-count=1 --remotes=origin`. A returned commit without a
   resolvable default head is an error; successful empty output may pass no
   start point and preserve the existing orphan behavior. A nonzero exit or
   cancellation remains a hard error.

Call `git worktree add` with the selected OID, not the mutable ref name. Keep
the existing canonical-detach and sibling-worktree collision recovery around
that single selected start point. Continue calling `set_upstream` after every
successful named-branch worktree creation.

Delete `start_point_unresolvable`; no replacement string matcher is added.
The separate C-locale matcher for branch-ownership collisions stays scoped to
that different condition.

### P2 — Make the generic failure guidance accurate

Keep registry errors sanitized rather than persisting raw Git output. Adjust
the generic manager guidance to name the actual failure classes—repository
access, branch selection, or local Git configuration—without asserting that
credentials are the likely cause. Also change the success-shaped trace message
`repository ready` to neutral completion wording when `clone_ok` is false.

Do not widen this phase into returning raw setup transcripts through HTTP or
SQLite; clone commands and remote errors may contain credentials.

Update the existing manager regression that currently requires the phrase
`this machine's Git credentials`; invert that old expectation rather than only
adding a second assertion beside it.

## Tests

All tests stay in the existing Rust test module and use real temporary Git
repositories and the real Git executable. No mocks or fake stderr fixtures are
needed because start-ref resolution no longer inspects stderr wording.

### Existing behavior to retain and strengthen

- Existing remote branch: assert the requested branch and remote content.
- Missing requested branch: retain
  `fresh_clone_of_a_new_branch_creates_it_locally_from_canonical`, and add
  assertions that:
  - the resulting content is the default branch's commit;
  - exactly one `worktree add` ran and used the resolved default commit OID,
    not the missing ref name;
  - `branch.<name>.remote` is `origin`;
  - `branch.<name>.merge` is `refs/heads/<name>`.
- Empty remote: retain the orphan-worktree test and first-commit proof.
- Canonical default-branch collision: retain the existing real-Git coverage
  and assert the OID-based retry still succeeds.

### New focused coverage

- Ref resolver returns the exact commit OID for an existing remote ref.
- Ref resolver returns `None` for an absent ref without relying on stderr.
- Missing/dangling `origin/HEAD` is repaired and then selected.
- A nonempty remote without a resolvable advertised head fails rather than
  silently widening to orphan creation.
- An existing non-default requested remote branch wins over `origin/HEAD` and
  contributes its distinct content.
- A real sibling worktree holding the requested branch still reaches the
  detached-worktree fallback with the same resolved OID.
- A resolver command failure that is not an absent ref remains an error and
  does not fall through to orphan creation, if this can be exercised with a
  real malformed repository fixture rather than a mocked process.
- Manager failure text remains sanitized and no test fixture contains a real
  customer repository or credential.

## Verification

Completed successfully: repository formatting, Rust formatting, 18 focused
clone tests, 29 sandbox-manager tests, clippy with warnings denied, and the
complete native Cargo workspace suite.

Commands used from the isolated worktree root, with Rust checks run from
`apps/native`:

```bash
bun run fmt
cd apps/native
cargo fmt --all -- --check
cargo test -p local-api setup::clone::tests:: -- --test-threads=1
cargo test -p local-api sandbox::manager::tests:: -- --test-threads=1
cargo clippy -p local-api --all-targets -- -D warnings
```

The complete native Rust test suite followed the focused checks:

```bash
cargo test --workspace
```

Linux CI must execute the same real-repository tests. The regression is closed
by removing stderr classification from start-ref resolution, so correctness no
longer depends on whether the CI runner's Git happens to emit the reporter's
exact phrase.

## Scope and rollout

In scope:

- native shared-repository worktree acquisition;
- tests for ref selection and fallback semantics;
- sanitized failure guidance directly adjacent to this path.

Out of scope:

- the independent Codex/OpenCode readiness-probe warnings in the support
  bundle;
- Linux Secret Service/keyring behavior;
- hosted sandbox acquisition;
- changing protected-branch normalization (`main`/`master` to `staging`);
- redesigning the separate worktree-branch-collision detector.

No database, HTTP, tool-contract, UI, i18n, or migration changes are expected.
No rollout flag is proposed: this restores the already-documented fallback
contract and removes version-dependent inference rather than introducing a new
acquisition mode. The change remains bounded to local Git setup and is covered
on existing-branch, new-branch, collision, and empty-repository variants before
release. An existing requested branch costs one extra local ref-resolution
command. A missing branch also runs the exact-ref absence confirmation and
default-head resolution; those probes are local. The change adds no retry loop,
no new steady-state network I/O, and no additional mutating Git operation.

## Review checklist

- No human-readable Git stderr controls ref selection.
- No mutable ref is passed after a successful structural resolution.
- No absent-ref result masks cancellation or another Git failure.
- New local branches still track their same-named future upstream.
- Empty repositories remain usable through their first commit.
- Canonical and explicit sibling-worktree collision regressions pass.
- Persisted/logged diagnostics contain no new credential-bearing values.
- Formatting, focused tests, clippy, and the native workspace suite pass.
