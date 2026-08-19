# Org filesystem on the desktop — implementation plan

Restores the `org/` filesystem for the Tauri desktop app, which `bunx decocms
link` had and the Rust `local-api` never implemented.

**Status:** plan only. Nothing below is built yet.

## Why

`decocms link` mounted the org's volumes into every sandbox, so an agent could
read `org/home/MEMORY.md`, load skills from `org/public/<set>/`, read the user's
chat attachments from `org/upload/`, and write deliverables to `org/output/`.

The Rust backend implements **none** of it. `routes/orgfs.rs` exists but is a
config *relay* only — it validates a config and writes it to a file a
privileged sidecar would watch. On the desktop it never even does that:
`ORGFS_CONFIG` and `ORGFS_SIDECAR_CONFIG_PATH` are never set, so the handler
returns `{"written": false}` and exits.

The gap that bites today: `decopilot.rs` computes `has_attachments()` and
reports it in the queue payload — the UI shows the paperclip — but nothing
materializes the file. **A user attaches a file and the agent cannot see it.**

The gap that does *not* bite: `buildOrgFilesystemPrompt` (the block naming
`org/home`, `org/upload`, …) is consumed by the *cluster* decopilot harness.
`append_claude_args` injects no system prompt, so no desktop agent is currently
told to read a path that does not exist. Prompt work must therefore come
**after** the paths exist, never before.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Mount, not materialize** | Live `org/home` browsing is a requirement. Ad-hoc download/upload cannot offer it. |
| 2 | **Shared mounts per org** at `<appRoot>/orgs/<slug>/` | Volumes are org-wide and every sandbox is the same user on one machine. Mounting per sandbox would run N×4 rclone processes serving identical content. Same shape as the canonical repo store: share one, link many. |
| 3 | **No hidden `.uploads`/`.outputs`** | The dot-prefix existed so "a stray symlink never collides with a real volume mount". Mounts now live in `orgs/`, symlinks in `sandboxes/<handle>/org/` — different trees, no collision possible. |
| 4 | **`org` is a sibling of `repo`** | Keeps the mount out of the git worktree. A hung NFS mount cannot wedge `bun install`, the dev server, or any git operation. |
| 5 | **Absolute paths in the prompt**, no `repo/org` symlink | Nothing enters the worktree at all, so no `.git/info/exclude` entry is needed — a simplification over `link`. |
| 6 | **No per-thread symlink repointing** | Narrowing moves off the filesystem into the prompt, which is built per dispatch and names `…/uploads/<threadId>/` directly. No repointing, no race between concurrent runs. Thread subdirs still exist because that layout is a cluster contract (see Constraints). |
| 7 | **Lazy mount on first sandbox ensure** | Users who never open a repo-backed agent never start rclone. |
| 8 | **macOS and Linux** | `rust-checks`, `contract-suite` and `tauri-build` each run a `macos-latest` and an `ubuntu-22.04` leg, so both mount stacks are gated. Windows stays out — see Non-goals. |
| 9 | **Bundle rclone** (not download-on-first-use) | Avoids a network dependency and macOS quarantine handling at runtime. |
| 10 | **Mount down ⇒ agent sees an empty `org/`** | The view always exists; a failed mount reads as empty rather than a missing path. |

### Constraints that are not ours to choose

- **`uploads`/`outputs` subdir layout is a cluster contract.** `file-materializer`
  writes attachments under the thread's folder, and outputs are "shared back to
  the organization under this run's folder". Flattening would mean desktop
  cannot find cluster-written uploads, and desktop-written outputs would not
  surface where the org's UI looks for them.
- **The official rclone build is required.** Homebrew's ships without `mount`.
- **rclone must run in the foreground.** `mount --rc --daemon` is broken — the
  launcher hangs and never attaches the mount. It is a supervised child process.

## Layout

```
<appRoot>/orgs/<orgSlug>/          ← the ONLY real mounts, one rclone set per org
├── home/                          rw
├── public/<set>/                  ro
├── uploads/<threadId>/            rw   (subdir layout = cluster contract)
└── outputs/<threadId>/            rw

<appRoot>/worktrees/<handle>/
├── repo/                          ← git worktree, harness cwd — nothing org-related inside
└── org/                           ← per-sandbox view: symlinks into the org mounts
    ├── home    -> ../../../orgs/<orgSlug>/home
    ├── public  -> ../../../orgs/<orgSlug>/public
    ├── uploads -> ../../../orgs/<orgSlug>/uploads
    └── outputs -> ../../../orgs/<orgSlug>/outputs
```

For reference, what `decocms link` actually produced (verified on disk) —
mounts were per sandbox, and `upload`/`output` were per-run symlinks into
*hidden* mounts:

```
~/deco/sandboxes/<handle>/
├── repo/
│   ├── .git/info/exclude          ← contained "/org"
│   └── org -> ../org
├── org/
│   ├── home/  public/<set>/       ← mounts
│   ├── .outputs/  .uploads/       ← hidden mounts
│   ├── output -> .outputs/<threadId>
│   └── upload -> .uploads/<threadId>
└── tmp/
```

## Phases

Land **P0–P2 behind a default-off flag** before P3–P5. Per the repo's
first-pass checklist: a change on a boot/spawn hot path gets its own flag, and
"deployed" must not mean "enabled".

### P0 — rclone sidecar

**Verified on macOS 26.5.2 / arm64 with rclone v1.74.4 — mount, read, write,
mkdir, rename, delete all confirmed end to end through a hardened-runtime
signed binary.**

Bundle a pinned official rclone as a Tauri `externalBin`, signed with the app.

```json5
// src-tauri/tauri.conf.json5 → bundle
externalBin: ["binaries/rclone"]
// files: src-tauri/binaries/rclone-aarch64-apple-darwin
//        src-tauri/binaries/rclone-x86_64-apple-darwin
```

- **Size is 78 MB per arch (156 MB for both)** — not the ~50 MB first assumed.
  Fetch + checksum-verify in `beforeBuildCommand`/CI into a git-ignored
  `src-tauri/binaries/`, rather than committing the binaries.
- Pin **v1.74.4** and verify against the published
  `https://downloads.rclone.org/<version>/SHA256SUMS`. Homebrew's build has no
  `mount` — the official build is required.
- **No `tauri-plugin-shell` needed.** The bundler copies externalBins into
  `<App>.app/Contents/MacOS/` with the triple stripped, so
  `current_exe()?.parent()?.join("rclone")` resolves it. That avoids adding
  `shell:allow-execute` to `capabilities/`, and a supervised long-lived child
  wants `tokio::process::Command` anyway.
- **Signing is automatic** — the bundler signs every externalBin before the app
  ("inside out") with `--options runtime` under hardened runtime, replacing
  rclone's shipped ad-hoc signature. No entitlements needed: rclone links only
  system libs, and hardened runtime permits its `/sbin/mount_nfs` exec.
- Keep the mount call behind a single `#[cfg(target_os = "macos")]` seam that
  returns a clean "unsupported" elsewhere.

Two caveats worth knowing before trusting a green run:

- `scripts/dev-runner.sh:10` short-circuits on any binary not named
  `decocms-desktop`, so in `tauri dev` the sidecar is **not** signed by the dev
  runner. Dev runs therefore do not exercise the signing path.
- `mount_nfs` is incompatible with App Sandbox, so this feature rules out Mac
  App Store distribution. Direct Developer ID + notarization is unaffected.

### P1 — WebDAV server in Rust

A loopback WebDAV surface backed by `upstream::call_org_tool` against the
`ORG_FS_*` tools.

- Methods rclone needs: `OPTIONS`, `PROPFIND`, `HEAD`, `GET`, `PUT`, `DELETE`,
  `MKCOL`, `MOVE`.
- Read-only enforced per volume (`public/*`), rejecting writes at this layer
  rather than trusting the mount flag.
- **No token minting.** `ORGFS_CONFIG` carried a short-lived fs-scoped API key
  because the cluster pod had no identity; Rust already holds the user's
  session. The entire key-provisioning path disappears.
- Never block the tokio runtime in a handler — the TS daemon documented a
  deadlock (kernel → rclone → WebDAV → blocked event loop). A multi-threaded
  executor makes this far less likely but not impossible.

**Done when:** unit tests cover each method and the read-only rejection, and
`rclone lsd` against the loopback URL lists the org's volumes.

### P2 — Mount manager (shared per org)

- Mount `<appRoot>/orgs/<slug>/{home,public/<set>,uploads,outputs}` lazily on
  the first sandbox ensure for that org.
- rclone as a supervised foreground child, reaped with the sandbox lifecycle.
- Cache invalidation via rclone's `rc` control API.
- **Stale-mount detach at boot**, mirroring `repo_store::prune_all`. A SIGKILL
  leaves mounts attached; the next run must reclaim them.
- Idempotent: a second ensure for the same org must not spawn a second rclone.

**Verified mount argv:**

```
rclone nfsmount wd: <mountPath>
  --option actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse
  --vfs-cache-mode full --vfs-write-back 1s --dir-cache-time 10s
  --timeout 5s --contimeout 3s --low-level-retries 1
  --rc --rc-addr 127.0.0.1:<port> --rc-no-auth
  [--read-only --file-perms 0755]        # public/* volumes
```

**Auth — a bearer is NOT enough.** The remote is configured by env, no config
file:

```sh
RCLONE_CONFIG_WD_TYPE=webdav
RCLONE_CONFIG_WD_URL=http://<exact app host>/_sandbox/orgfs/<org>/<volume>
RCLONE_CONFIG_WD_VENDOR=other
RCLONE_CONFIG_WD_HEADERS="Origin,<control origin>,Cookie,<session cookie>"
```

The shipped app runs local-api **embedded**, where `guard` requires the exact
`Host` (so the URL host:port must match the app's string exactly —
`localhost:43120`, not `127.0.0.1:43120`), the exact `Origin` on unsafe methods
(**`PROPFIND` counts as unsafe**; rclone sends no `Origin` by default), and the
per-launch session cookie. Without the headers this fails as
`couldn't list files: forbidden origin: 403`.

Use the **env** form, not `--header` on argv — argv is world-readable via `ps`,
the same rule the keychain-helper work established. The session token is
generated once per process (`client_auth.rs`) and never rotates, and rclone is
the app's own child, so the credential's lifetime already matches the mount's.

**Timeouts are not optional.** rclone's defaults give a ~9-hour worst-case
block when the backing server stops answering (its VFS downloader retries to a
hard-coded 10-error limit: `--timeout` × `--low-level-retries` × 11). Measured:
defaults >5 min and climbing; `--timeout 5s --low-level-retries 1` → 62 s. The
failure surfaces as `EACCES` ("Permission denied"), not `EIO` — worth an
`[org-fs]` log line so it is not misread. The mount fully recovers once the
server answers again; no remount needed.

**Readiness:** poll `rc` `POST /vfs/list` for liveness, then confirm with
`statfs(mountpoint).f_fstypename == "nfs"` — `vfs/list` goes non-empty ~36 ms
*before* the kernel attaches the mount (0.080 s vs 0.116 s measured). Fail fast
if the child exits. `nfsmount --daemon --rc` is confirmed broken (exits 1), so
the foreground supervised child is mandatory.

**Invalidation:** `rc` `POST /vfs/refresh` with `{"dir":"sub"}`, and `{}` for
the root — `{"dir":""}` returns `file does not exist`. Freshness is two-layered
(rclone's VFS dir cache plus the kernel attr cache), so budget ~1 s after a
refresh.

**The boot sweep is overdue, not theoretical.** This machine currently has
**21 ghost NFS mounts** under the old TS link daemon's sandbox dirs with **no
rclone process alive** to back them. Sweep by parsing `mount` for `nfs` entries
whose *mountpoint* is under `<appRoot>/orgs/` and `umount -f` each — keyed on
mountpoint, never the source, because rclone derives the export name from
remote+config hash and distinct mounts collide on it (`localhost:/wd{KnsWa}`
appeared for three different mountpoints). `umount -f` reclaims instantly and
exits 1 harmlessly on a non-mount, so the sweep can be unconditional.

**Done when:** two sandboxes in one org share one rclone set, `mount` shows the
expected NFS entries, and a killed app leaves nothing stale after the next boot.

### P3 — Per-sandbox org view

Create the four symlinks at ensure; remove them on sandbox delete.

- Nothing is written inside `repo/`, so no `.git/info/exclude` entry.
- Symlinks are relative, so the tree survives being moved.

**Done when:** `<sandbox>/org/home` resolves to the mounted volume and
`git status` in the worktree is unchanged by the view existing.

### P4 — Desktop prompt

A desktop variant of `buildOrgFilesystemPrompt` emitting **absolute** paths,
including this thread's `uploads/`/`outputs/` directory.

**Injection mechanism — verified against the installed CLIs, both work:**

| Harness | Flag | Semantics |
|---|---|---|
| `claude-code` | `--append-system-prompt <prompt>` | **Appends** to the CLI's default prompt; non-destructive. (`--system-prompt` would replace it — do not use.) |
| `codex` | `-c developer_instructions=<prompt>` | Sets the developer-instruction layer. Multi-line values pass through `-c` correctly. |

Verified empirically, not just from `--help`: with
`-c developer_instructions="…answer with exactly BANANA"`, `codex exec` answered
`BANANA` to "What is 2+2?", and a multi-line block produced its sentinel too.

Notes for implementation:

- `codex` has **no** file-based variant — `experimental_instructions_file`,
  `instructions_file` and `base_instructions` are all rejected by
  `--strict-config`. Only `instructions` and `developer_instructions` are real
  config keys.
- `developer_instructions` **sets** the developer layer rather than appending.
  Rust passes none today, so the org block is purely additive — but if a second
  block is ever added it must be composed into ONE string, the way the TS
  harness joins its parts array.
- The asymmetry is deliberate: claude appends, codex sets. Do not model these
  as one "system prompt" parameter without accounting for it.

Strictly gated on P1–P3 landing. Naming a path before it exists reproduces
the silent-wrong-path failure this plan exists to remove.

### P5 — Degradation and observability

- Emit a `[org-fs]` line into the setup transcript when a mount is skipped or
  fails, so "no files found" is distinguishable from "storage unavailable".
- Never fail a dispatch because a mount failed (consistent with clone/fetch
  failures, which fall back rather than aborting the run).

## P6 — Final verification (drive the real app)

Unit tests do not prove an agent can see the org. This phase drives the running
app through the Tauri MCP bridge and asserts on the filesystem underneath.

**Setup**

1. `bun run --cwd=apps/native dev`
2. Bridge listens on `ws://127.0.0.1:9223`; drive it with `execute_js`
   (debug builds only).
3. Use a git-backed agent whose GitHub attachment is **active** — a `detached`
   attachment never auto-starts a sandbox, which is a pre-existing product
   behavior unrelated to this work.

**Driving the chat**

The composer is a `[contenteditable=true]` div, *not* the 8×20px `<textarea>`
(that one is a measurement element and typing into it leaves Send disabled):

```js
const d = document.querySelector('[contenteditable=true]');
d.focus();
document.execCommand('insertText', false, PROMPT);
document.querySelector('button[aria-label="Send message"]').click();
```

Confirm the send landed by reading the `Messages` counter in the context panel
— a cleared composer alone does not prove submission.

**Assertions**

| # | Check | How |
|---|---|---|
| 1 | Agent responds | `Messages` increments and an assistant turn renders |
| 2 | Mounts are up | `mount \| grep <appRoot>/orgs/<slug>` lists the NFS entries |
| 3 | View is wired | `<sandbox>/org/home` resolves; all four symlinks point into `orgs/<slug>/` |
| 4 | Worktree is clean | no `org` entry inside `<sandbox>/repo/`; `git status` unaffected |
| 5 | **Agent sees repo files** | ask it to read a known file; response quotes real content |
| 6 | **Agent changes repo files** | ask it to write a token to a new file; assert on disk **in the worktree**, and assert the shared `<appRoot>/repo` stays empty |
| 7 | **Agent sees the org** | ask what it knows about this organization; response reflects real `org/home` content, not a guess |
| 8 | **Agent reads an attachment** | attach a file in the UI, ask the agent to summarize it; it must read from the thread's `uploads/<threadId>/` |
| 9 | **Agent writes a deliverable** | ask it to write to `outputs/`; assert the file appears in the org volume |
| 10 | Degrades cleanly | stop the mount, re-run: `org/` reads empty, a `[org-fs]` line appears, the dispatch still completes |

Checks 6 and 7 are the ones that matter most — 6 caught a real bug already
(the agent wrote to the shared `<appRoot>/repo` instead of the worktree), and 7
is the entire point of choosing mount over materialize.

## Linux

The volumes, layout, claim/settle state machine and readiness path are shared;
only the mount stack differs, and each difference is a runtime seam
(`LINUX_MOUNT_STACK`, `mount_args(linux, …)`, `detach_commands(linux, …)`) so
both dialects compile and unit-test on either host.

- **Mount** — `rclone mount` over its own FUSE support rather than
  `rclone nfsmount`; the shared flag tail is identical. No `--allow-other`: the
  desktop mounts and reads as one uid, and omitting it removes the
  `user_allow_other` requirement in `/etc/fuse.conf` entirely. `--file-perms`
  covers a remote that carries no mode bits, which the read-only `public`
  volume needs for executable helper scripts.
- **Mount table** — `/proc/self/mounts` read directly, with octal unescaping,
  instead of spawning BSD `mount`. `wait_until_mounted` polls it per volume, so
  avoiding a subprocess there matters.
- **Attachment vs sweep** — "is our path attached?" ignores the filesystem
  type; only the stale-mount sweep filters on it, where a miss is safe. Gating
  attachment on the type made an unrecognized one kill a working rclone and
  loop forever.
- **Detach** — `fusermount3 -uz`, then `fusermount -uz`, then `umount -l`, each
  bounded by a timeout: lazy bounds the kernel's half of the detach, not
  libfuse's pre-flight `stat`, which a wedged server blocks forever.
- **Host requirement** — `fuse3` (Debian 12+, Ubuntu 22.04+, Fedora and Arch
  ship it). The bundled rclone references both `fusermount3` and the fuse2-era
  `fusermount`; the detach chain tries both names either way.

## Non-goals

- **Idle reaper** — explicitly out of scope.
- **Windows mounting** — Windows needs WinFsp, a third-party kernel driver,
  which reintroduces exactly the dependency macOS `nfsmount` avoids. Linux is
  no longer a non-goal: it mounts through rclone's own FUSE support, which
  needs no driver install beyond `fuse3`, and is described below.
- **`offload-fetch` / `messagesRef`** — messages are sent inline on desktop.
- **The link-daemon transport layer** (tunnel, outbox, NATS control plane,
  local ingress, machine-id) — architecturally obsolete: the webview talks to
  localhost, so there is no cluster→machine hop to maintain.

## Risks

| Risk | Mitigation |
|---|---|
| Hung NFS mount blocks syscalls | `org` is a sibling of `repo`, so install/dev/git never touch the mount |
| Stale mounts after SIGKILL | Detach at boot (P2) |
| rclone in a signed, hardened-runtime bundle | Verified in P0 before anything depends on it |
| Prompt names a path that does not exist | P4 is gated on P1–P3 |
| ~~No way to inject a system prompt into the CLIs~~ | **Resolved** — `--append-system-prompt` (claude) and `-c developer_instructions` (codex), both verified end-to-end |
| Desktop outputs invisible to the org | Keep the cluster's thread-scoped subdir layout |
