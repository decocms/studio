# Org filesystem in hosted sandboxes

Org-fs exposes an organization's Studio files as ordinary paths under
`/app/org/` inside a hosted sandbox pod, so every harness (including CLIs that
only read real files) can read and write them. This page covers the hosted
(Kubernetes) path. The desktop app mounts org-fs itself; see
[`apps/native/docs/org-fs-plan.md`](../../../apps/native/docs/org-fs-plan.md).

## Overview

Three parties split the work:

| Party | Code | Job |
| --- | --- | --- |
| Studio API | `apps/api/src/file-storage/mount/provisioning.ts`, `packages/sandbox/server/provider/agent-sandbox/runner.ts` | Mints an fs-scoped API key, builds the mount config, and posts it to the daemon after the claim binds |
| Daemon (unprivileged, Go) | `daemon-go/internal/routes/misc.go`, `daemon-go/internal/orgfs/` | Relays the config to the sidecar, then owns every symlink, skill prefetch, and session copy that reads from the mounts |
| Sidecar (privileged, Bun) | this directory (`sidecar-main.ts`) | Serves a loopback WebDAV server per volume and runs `rclone mount` against it |

The daemon cannot mount anything. The sandbox container drops all
capabilities, disallows privilege escalation, and runs non-root. Only the
`orgfs-sidecar` container is privileged.

## Request path

```
agent reads /app/org/home/notes.md
  → kernel FUSE (mount propagated from the sidecar)
  → rclone mount --vfs-cache-mode full        (sidecar, one process per volume)
  → WebDAV on 127.0.0.1:<random>              (sidecar, webdav.ts, one server per volume)
  → OrgFsClient                               (client.ts)
  → Studio /api/:org/fs/:volume/{list,stat,read,file,dir,move,changes}
  → S3
```

Studio presigns large reads (`read?presign=1`), and `client.ts` then fetches
the bytes directly from S3 with the caller's `Range` header. If the presigned
host is unreachable from the pod, the client falls back to a read buffered
through Studio.

## Provisioning sequence

1. **Pod boot.** The chart (`deploy/helm/sandbox-env/templates/sandbox-template.yaml`)
   adds the sidecar and two `emptyDir` volumes. `orgfs-org` holds the mounts
   at `/app/org` (Bidirectional in the sidecar, HostToContainer in the sandbox
   container). `orgfs-ctl` is the control volume at `/run/orgfs`. The daemon
   receives `ORGFS_SIDECAR_CONFIG_PATH=/run/orgfs/config.json` and
   `ORGFS_SIDECAR_STATUS_PATH=/run/orgfs/status.json`. The sidecar starts and
   polls for the config file every second.
2. **Claim bind.** Studio calls `mintOrgFsConfigJson`, which creates an API key
   limited to `ORG_FS_READ`/`ORG_FS_WRITE` with a 7-day TTL and builds the
   `OrgFsMountConfig`. The runner then posts it to
   `POST /_sandbox/orgfs-config`. The config is delivered after bind rather
   than in the pod env because warm-pool claims reject `spec.env`. A failed
   mint or relay logs a warning and never fails provisioning.
3. **Relay.** The daemon validates the payload (`orgfs.ParseConfig`), keeps
   `baseUrl`/`orgSlug`/`token` for its own HTTP calls (`SetAPIConfig`), and
   atomically writes the raw JSON to the config path. The route is excluded
   from the link gate, because that gate waits on mounts that exist only after
   this POST.
4. **Mount.** The sidecar parses the config (`config.ts`) and mounts every
   volume concurrently (`mount-manager.ts`). Each volume gets its own
   `OrgFsClient`, its own loopback WebDAV server, and its own
   `rclone mount --allow-other` process (`mounter.ts`). A mount counts as live
   once rclone's rc API reports a VFS, within 15 s. A volume that fails is
   logged and skipped; the others still mount.
5. **Status.** The sidecar atomically writes `status.json` with the volumes
   that actually mounted. The config is consumed once. Pods are single-claim,
   so later rewrites are ignored.

The daemon never infers a mount from directory existence, because a mount
point directory exists even when its mount failed. Every link and copy is
gated on `status.json` (`Links.ActiveMounts`). Writing into an unmounted
mount point would put user files on ephemeral disk.

## Volume layout

`buildOrgFsConfig` defines the mount set:

| Volume | Mount path | Mode | Purpose |
| --- | --- | --- | --- |
| `home` | `org/home` | read-write | Org-wide shared folder; also holds `skills/` and `claude-sessions/` |
| `outputs` | `org/.outputs` | read-write | Per-thread outputs; the agent sees them through `org/output` |
| `uploads` | `org/.uploads` | read-write | Per-thread chat attachments; the agent sees them through `org/upload` |
| `public-<set>` | `org/public/<set>` | read-only | Shared public skill sets |
| repo-sync volumes | `org/<volume>` | read-only | Org repo syncs enabled when the sandbox started |

Read-only mounts use `--read-only --file-perms 0755`, since org-fs stores no
mode bits and skill scripts need the exec bit. The mount set is fixed when
the sandbox starts. A repo sync added later mounts on the next start, while
content in volumes that are already mounted stays live.

## What the daemon builds on top

`daemon-go/internal/orgfs/links.go` fails open everywhere except the
dispatch gate described below.

- **Repo link.** `<repo>/org → ../org`, added to `.git/info/exclude`, so
  relative `org/...` paths resolve from the harness cwd. The link is created
  at dispatch time, not at boot, because an existing link makes `git clone`
  refuse the directory. A real `org/` tracked by the repo takes precedence.
- **Per-run links.** `org/output → .outputs/<threadId>` and
  `org/upload → .uploads/<threadId>` are repointed on every fs/exec call that
  carries `x-thread-id` and at dispatch. A real, non-empty `org/output` is
  never replaced.
- **Home skills.** `$CLAUDE_CONFIG_DIR/skills` (or `~/.claude/skills`) is
  symlinked to `org/home/skills`, so a skill the agent writes there becomes an
  org-fs write. The link is placed only after a read probe (3 s per file)
  succeeds. A timeout condemns the set, while other errors only skip that one
  skill.
- **Read-only skill sets.** Public and repo-sync sets are copied, not linked,
  into the local plugin directory `/app/orgfs-skills`. The harness receives it
  through `CLAUDE_CODE_PLUGIN_DIRS`. The copy uses
  `GET /api/:org/fs/:volume/skills.tar` first and falls back to walking the
  mount. It is capped in bytes and time and runs once per pod.
- **Sessions.** Before each run, `RestoreSession` copies
  `org/home/claude-sessions/<threadId>/` into the Claude config directory.
  After each run, `SaveSession` copies it back, so a follow-up in a new pod
  resumes the conversation. These are copies, never mounts, because the SDK
  reads the transcript on its startup path.
- **Stray skills.** `AdoptStrayRepoSkills` moves untracked
  `<repo>/.claude/skills/*` directories onto the home mount after a run.

Dispatch (`main.go` `BeforeRun`) is the one place that blocks.
`WaitHomeReady` waits up to 90 s, once per pod, for `home` to mount and skills
to link, because a run without its skills or transcript completes with a
wrong answer instead of an error. `WaitSkillLinks` then waits a bounded time
for the plugin copy, since Claude Code scans skills only at startup.

## Freshness and failure handling

- **External writes.** WebDAV has no change notification. For each volume,
  `invalidator.ts` long-polls `/changes?wait=1` and calls rclone's
  `vfs/refresh` on the parent directory of each changed path. The first drain
  only primes the cursor. `--dir-cache-time 10s` is the fallback bound.
  `vfs/refresh` is used instead of `vfs/forget`, because forget kills open
  handles, including the mount's own in-flight writes.
- **Own writes.** `--vfs-write-back 1s` uploads closed files about a second
  after close.
- **rclone crash.** `MountManager` watches each rclone process. On an
  unexpected exit it detaches the stale mount and remounts once. Deliberate
  teardown sets `closing` first, so it is not treated as a crash.
- **Teardown.** On SIGTERM the sidecar detaches with non-blocking
  `fusermount -uz` / `umount -l`, then gives rclone 5 s to flush before
  SIGKILL. Unflushed writes at teardown are best-effort.
- **Path safety.** `resolveMountPath` / `safe-path.ts` clamp every mount
  target inside `/app`. The daemon validates thread IDs and skill names as
  single path segments, and `skills.tar` entries that could escape their
  directory are refused.

## Development

```sh
bun test packages/sandbox/orgfs
cd packages/sandbox/daemon-go && go test ./internal/orgfs/...
```

The daemon's side of the relay is covered black-box by
`packages/sandbox/daemon-e2e/daemon.orgfs.e2e.test.ts`. The sidecar image is
built from `deploy/helm/sandbox-env/orgfs-sidecar/Dockerfile` and released by
`.github/workflows/release-orgfs-sidecar.yaml` when `orgFs.image.tag` in
`deploy/helm/sandbox-env/values.yaml` changes.

## Debug switches

| Switch | Effect |
| --- | --- |
| `disableFsSidecar: true` (chart) | Removes the sidecar and its volumes and restores `hostUsers: false`. The daemon env vars are removed too, so every `Links` method becomes a no-op. |
| `DISABLE_ORGFS_MOUNTS` (Studio env) | Studio skips minting the config; the sidecar stays up with nothing to mount. |

Neither is a supported production mode, because Studio prompts still refer to
`org/` paths.

## Related documentation

- [Sandbox package](../README.md)
- [Go daemon](../daemon-go/README.md)
- [sandbox-env chart](../../../deploy/helm/sandbox-env/README.md)
- [Studio architecture: org filesystem](../../../apps/docs/client/src/content/deco-studio/en/studio/architecture.mdx)
