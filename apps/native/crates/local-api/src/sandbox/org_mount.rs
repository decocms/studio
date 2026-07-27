//! Lifecycle of the shared org-filesystem NFS mounts.
//!
//! The volumes are mounted once per organization under `<app_root>/orgs/<slug>`
//! and each sandbox links into them (see [`super::org_view`]). This module owns
//! the mounts themselves; P2 of `apps/native/docs/org-fs-plan.md`.
//!
//! ## Why a boot sweep exists at all
//!
//! An NFS mount outlives the process that served it. When the app is SIGKILLed
//! — which happens routinely during development, and to any app the user force
//! quits — rclone dies but the kernel keeps the mount in its table, backed by
//! nothing. The directory is then unusable: the first access blocks for about
//! eight seconds and every later one fails instantly with `ETIMEDOUT`, so the
//! sandbox that owns it can never be re-provisioned at the same path.
//!
//! This is not theoretical. Before this module existed, a development machine
//! had accumulated **21** such ghosts from the previous TS `link` daemon, with
//! no `rclone` process alive to back any of them.
//!
//! `umount -f` reclaims one instantly, and exits non-zero harmlessly when the
//! path is not a mount — so the sweep can run unconditionally at boot without
//! first proving anything about each entry.
//!
//! ## Why entries are keyed by mountpoint, never by source
//!
//! rclone derives its NFS export name from the remote plus a config hash, so
//! several distinct mounts share one source string: three different mountpoints
//! were observed all reporting `localhost:/wd{KnsWa}`. Only the mountpoint
//! identifies a mount, so only the mountpoint decides what this sweeps.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

use super::org_view::ORG_VOLUMES;

/// What `rclone` needs to satisfy local-api's own guard.
///
/// A bearer is NOT sufficient: the shipped app runs embedded, where the guard
/// wants the exact `Host`, the exact `Origin` on unsafe methods (and
/// `PROPFIND` is unsafe — rclone sends no `Origin` by default), and the
/// per-launch session cookie. Without all three, listing fails with
/// `couldn't list files: forbidden origin: 403`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountCredentials {
    /// `http://<exact expected host>` — the host string must match what the
    /// guard compares against, byte for byte, or every request is rejected.
    pub base_url: String,
    pub origin: String,
    pub cookie: String,
}

fn credentials_cell() -> &'static OnceLock<MountCredentials> {
    static CREDENTIALS: OnceLock<MountCredentials> = OnceLock::new();
    &CREDENTIALS
}

/// The published credentials, for anything else that must satisfy this
/// process's own guard — currently the agent MCP handed to a CLI harness.
pub fn local_credentials() -> Option<&'static MountCredentials> {
    credentials_cell().get()
}

/// Publish the credentials once at boot. Mirrors the process-global
/// `set_preview_port` convention rather than adding an `AppState` field,
/// which this module family may not do.
pub fn set_credentials(credentials: MountCredentials) {
    let _ = credentials_cell().set(credentials);
}

/// Live `rclone` children, keyed by mountpoint.
///
/// They are RETAINED here on purpose: `Child` is spawned with
/// `kill_on_drop`, so dropping one would tear down the mount it is serving.
fn children() -> &'static Mutex<HashMap<PathBuf, Child>> {
    static CHILDREN: OnceLock<Mutex<HashMap<PathBuf, Child>>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Per-org mount state.
///
/// The mounts are warmed when the app first touches an organization (see
/// [`warm`]), so by the time a sandbox needs them they are already up. That
/// means this state is consulted from a HOT path — every org-scoped request —
/// so every transition has to be a lock and a map lookup, never work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MountState {
    /// A mount attempt is running. Nobody else should start one.
    InFlight,
    /// Every volume is attached.
    Ready,
    /// The last attempt failed; refuse new ones until this passes.
    ///
    /// Without a cooldown a failing org would be retried by EVERY org-scoped
    /// request the webview makes — a spawn storm against an upstream that is
    /// already unhappy (the usual cause is simply that the user has not
    /// finished signing in).
    Failed { until: Instant },
}

/// How long a failed org is left alone before another attempt.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

/// How long [`wait_ready`] blocks a sandbox ensure on a mount that is not up
/// yet. Short on purpose: with warm mounts this never elapses, so it only
/// matters when something is broken — exactly when blocking provisioning is
/// the wrong trade. The sandbox proceeds with an empty view and says so.
pub const READY_TIMEOUT: Duration = Duration::from_secs(2);

fn states() -> &'static Mutex<HashMap<String, MountState>> {
    static STATES: OnceLock<Mutex<HashMap<String, MountState>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_states() -> std::sync::MutexGuard<'static, HashMap<String, MountState>> {
    states()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Claim the right to mount `org_slug`, or `None` if it is already mounted,
/// already being mounted, or cooling off after a failure.
fn claim(org_slug: &str) -> Option<()> {
    let mut states = lock_states();
    match states.get(org_slug) {
        Some(MountState::Ready) | Some(MountState::InFlight) => None,
        Some(MountState::Failed { until }) if Instant::now() < *until => None,
        _ => {
            states.insert(org_slug.to_string(), MountState::InFlight);
            Some(())
        }
    }
}

fn settle(org_slug: &str, ok: bool) {
    let state = if ok {
        MountState::Ready
    } else {
        MountState::Failed {
            until: Instant::now() + FAILURE_COOLDOWN,
        }
    };
    lock_states().insert(org_slug.to_string(), state);
}

/// Start mounting an organization's volumes, without waiting for them.
///
/// Called when the app first touches an org — which is both "the app booted
/// into this org" and "the user switched to it" — so the mounts are warming
/// while the user is still navigating to an agent. Cheap and idempotent: an
/// org that is ready, in flight, or cooling off returns immediately.
pub fn warm(app_root: &Path, org_slug: &str) {
    if claim(org_slug).is_none() {
        return;
    }
    let app_root = app_root.to_path_buf();
    let org = org_slug.to_string();
    tokio::spawn(async move {
        let ok = mount_all(&app_root, &org).await;
        settle(&org, ok);
    });
}

/// Wait for an organization's volumes to be attached, up to
/// [`READY_TIMEOUT`].
///
/// Returns whether they are. Starts the mount itself if nothing has — a
/// sandbox can be ensured without any org-scoped request having preceded it
/// (a resurrect on boot, a test), and such a caller must not wait out the
/// timeout for something nobody started.
pub async fn wait_ready(app_root: &Path, org_slug: &str) -> bool {
    warm(app_root, org_slug);
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match lock_states().get(org_slug).copied() {
            Some(MountState::Ready) => return true,
            Some(MountState::Failed { .. }) | None => return false,
            Some(MountState::InFlight) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The bundled rclone./// The bundled rclone.
///
/// Tauri strips the host triple when copying an `externalBin` into
/// `<App>.app/Contents/MacOS/`, so the packaged binary sits beside the app
/// executable. The triple-suffixed path is the `tauri dev` fallback, where
/// nothing has been copied yet.
fn rclone_binary() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.join("rclone");
    if bundled.is_file() {
        return Some(bundled);
    }
    // `<arch>-apple-darwin` matches both the Rust host triple `fetch-rclone.sh`
    // names its output with, and `std::env::consts::ARCH` (`aarch64`/`x86_64`).
    let dev = dir.join(format!("rclone-{}-apple-darwin", std::env::consts::ARCH));
    dev.is_file().then_some(dev)
}

/// Mount every volume of `org_slug` that is not already mounted.
///
/// Idempotent: a volume whose mountpoint already appears in the mount table is
/// left alone, so a second sandbox in the same org reuses the first one's
/// mounts instead of spawning a duplicate rclone.
///
/// Best-effort — a failure leaves the volume unmounted, which reads as an
/// empty directory through the sandbox's view rather than as an error.
async fn mount_all(app_root: &Path, org_slug: &str) -> bool {
    let (Some(root), Some(creds), Some(bin)) = (
        super::org_view::org_mount_root(app_root, org_slug),
        credentials_cell().get(),
        rclone_binary(),
    ) else {
        tracing::debug!(org_slug, "org-fs mount skipped: not configured");
        return false;
    };

    let mounted = mounted_paths().await;
    let mut all = true;
    for volume in ORG_VOLUMES {
        let mountpoint = root.join(volume);
        if mounted.contains(&mountpoint) {
            continue;
        }
        if let Err(error) = tokio::fs::create_dir_all(&mountpoint).await {
            tracing::warn!(%error, ?mountpoint, "could not create org mountpoint");
            all = false;
            continue;
        }
        match spawn_mount(&bin, &mountpoint, org_slug, volume, creds).await {
            Ok(child) => {
                children()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(mountpoint.clone(), child);
                if !wait_until_mounted(&mountpoint).await {
                    tracing::warn!(?mountpoint, "org volume did not attach in time");
                    all = false;
                }
            }
            Err(error) => {
                tracing::warn!(%error, ?mountpoint, "failed to spawn rclone");
                all = false;
            }
        }
    }
    all
}

/// Spawn a supervised `rclone nfsmount` for one volume.
///
/// Foreground, never `--daemon`: `nfsmount --daemon --rc` is broken in rclone
/// (it exits 1 rather than attaching), so the child has to be supervised here.
///
/// Everything secret travels by ENVIRONMENT, never argv — argv is readable by
/// any local process through `ps`, which is exactly why the keychain helper
/// avoids it too.
async fn spawn_mount(
    bin: &Path,
    mountpoint: &Path,
    org: &str,
    volume: &str,
    creds: &MountCredentials,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(bin);
    cmd.arg("nfsmount")
        .arg("wd:")
        .arg(mountpoint)
        .args([
            "--option",
            "actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse",
        ])
        .args(["--vfs-cache-mode", "full"])
        .args(["--vfs-write-back", "1s"])
        .args(["--dir-cache-time", "10s"])
        // rclone's DEFAULTS are unusable here: its VFS downloader retries to a
        // hard-coded 10-error limit, so `--timeout` x `--low-level-retries` x
        // 11 is the worst-case block when the backing server stops answering
        // — about NINE HOURS at the defaults. On loopback a request is either
        // instant or dead, so bound it aggressively.
        .args(["--timeout", "5s"])
        .args(["--contimeout", "3s"])
        .args(["--low-level-retries", "1"])
        .env("RCLONE_CONFIG_WD_TYPE", "webdav")
        .env(
            "RCLONE_CONFIG_WD_URL",
            format!("{}/_sandbox/orgfs/{org}/{volume}", creds.base_url),
        )
        .env("RCLONE_CONFIG_WD_VENDOR", "other")
        .env(
            "RCLONE_CONFIG_WD_HEADERS",
            format!("Origin,{},Cookie,{}", creds.origin, creds.cookie),
        )
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    if is_read_only(volume) {
        cmd.arg("--read-only");
    }
    cmd.spawn()
}

/// `public` is the org's curated, shared skill sets — this app must never
/// write to it, and saying so at mount time is one more layer under the
/// WebDAV surface's own refusal.
fn is_read_only(volume: &str) -> bool {
    volume.starts_with("public")
}

/// Wait for the kernel to actually attach the mount.
///
/// The mount TABLE is the authoritative signal. rclone's `rc` API reports
/// ready about 36 ms before the kernel attaches, so trusting it would hand
/// out a path that is not yet a mount.
async fn wait_until_mounted(mountpoint: &Path) -> bool {
    for _ in 0..40 {
        if mounted_paths().await.contains(&mountpoint.to_path_buf()) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// Every NFS mountpoint currently attached.
async fn mounted_paths() -> Vec<PathBuf> {
    let Ok(output) = Command::new("mount")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_mount_line)
        .filter(|(_, fstype)| fstype == "nfs")
        .map(|(mountpoint, _)| mountpoint)
        .collect()
}

/// Reclaim every stale org mount left behind by a previous run.
///
/// Best-effort and unconditional: a path that is not actually mounted simply
/// fails to unmount, which costs one process and nothing else. Scoped to
/// `<app_root>/orgs/` so it can never touch a mount this app does not own.
pub async fn prune_stale_mounts(app_root: &Path) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Ok(output) = tokio::process::Command::new("mount")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
    else {
        return;
    };
    // Kill the servers BEFORE reclaiming their mountpoints: an orphan still
    // answering NFS can keep a mount busy, and once its path is unmounted it
    // has nothing left to serve anyway.
    kill_orphaned_servers(app_root).await;

    let table = String::from_utf8_lossy(&output.stdout);
    for mountpoint in stale_mountpoints(&table, app_root) {
        let path = mountpoint.to_string_lossy().into_owned();
        let result = tokio::process::Command::new("umount")
            .args(["-f", &path])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status()
            .await;
        match result {
            Ok(status) if status.success() => {
                tracing::info!(mountpoint = %path, "reclaimed a stale org mount")
            }
            // Not mounted after all, or held by something: the next boot tries
            // again, and a sandbox that needs the path reports it.
            _ => tracing::debug!(mountpoint = %path, "stale org mount did not unmount"),
        }
    }
}

/// Kill `rclone` processes left over from a previous run of this app.
///
/// `kill_on_drop` only fires when the `Child` is DROPPED. A hard exit — a
/// SIGKILL, or the restart a dev loop performs on every rebuild — runs no
/// destructors, so the children survive, get reparented to init, and leak. One
/// development session accumulated EIGHT of them, each serving a mountpoint
/// that had already been reclaimed.
///
/// Safe to run unconditionally at boot precisely because it runs at boot: this
/// process has not spawned any mounts yet, so every match is somebody else's
/// corpse. Matching is scoped to argv that references this app root's `orgs/`
/// directory, so an rclone the user runs for their own purposes is untouched.
async fn kill_orphaned_servers(app_root: &Path) {
    let Some(marker) = app_root.join("orgs").to_str().map(str::to_string) else {
        return;
    };
    let Ok(output) = Command::new("ps")
        .args(["-eo", "pid=,command="])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
    else {
        return;
    };
    for pid in orphaned_rclone_pids(&String::from_utf8_lossy(&output.stdout), &marker) {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status()
            .await;
        tracing::info!(pid, "killed an orphaned org-fs mount server");
    }
}

/// PIDs of `rclone` processes whose argv mentions `marker`.
///
/// Pure so the matching — the part that decides what gets SIGKILLed — is
/// testable without spawning anything.
fn orphaned_rclone_pids(ps_output: &str, marker: &str) -> Vec<i32> {
    ps_output
        .lines()
        // All three, because this SIGKILLs what it matches: our orgs path, the
        // rclone binary, and the subcommand we actually spawn. Path alone would
        // match a `grep` for it; rclone alone would match the user's own.
        .filter(|line| {
            line.contains(marker) && line.contains("rclone") && line.contains("nfsmount")
        })
        .filter_map(|line| line.split_whitespace().next()?.parse::<i32>().ok())
        .collect()
}

/// The NFS mountpoints under `<app_root>/orgs/` named in a `mount` table.
///
/// Kept pure so the parsing — the part that can silently sweep the wrong path
/// — is testable without mounting anything.
fn stale_mountpoints(table: &str, app_root: &Path) -> Vec<PathBuf> {
    let orgs_root = app_root.join("orgs");
    table
        .lines()
        .filter_map(parse_mount_line)
        .filter(|(mountpoint, fstype)| fstype == "nfs" && mountpoint.starts_with(&orgs_root))
        .map(|(mountpoint, _)| mountpoint)
        .collect()
}

/// `<source> on <mountpoint> (<fstype>, <opts>…)` — the BSD `mount` format.
///
/// Split on the literal separators rather than on whitespace: a mountpoint may
/// contain spaces, and the source is discarded anyway (see this module's doc on
/// why sources cannot identify a mount).
fn parse_mount_line(line: &str) -> Option<(PathBuf, String)> {
    let (_, rest) = line.split_once(" on ")?;
    let (mountpoint, tail) = rest.rsplit_once(" (")?;
    let fstype = tail.split(',').next()?.trim_end_matches(')').trim();
    Some((PathBuf::from(mountpoint), fstype.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `mount` output captured on macOS, including the ghosts this sweep
    /// exists for.
    const TABLE: &str = concat!(
        "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n",
        "devfs on /dev (devfs, local, nobrowse)\n",
        "localhost:/wd{rkiaF} on /app/orgs/acme/home (nfs, nodev, nosuid, nobrowse, mounted by gimenes)\n",
        "localhost:/wd{rkiaF} on /app/orgs/acme/uploads (nfs, nodev, nosuid, nobrowse)\n",
        "localhost:/wd{other} on /app/orgs/other-org/public (nfs, nodev, nosuid)\n",
        "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)\n",
    );

    #[test]
    fn sweeps_every_nfs_mount_under_the_orgs_root() {
        let found = stale_mountpoints(TABLE, Path::new("/app"));
        assert_eq!(
            found,
            vec![
                PathBuf::from("/app/orgs/acme/home"),
                PathBuf::from("/app/orgs/acme/uploads"),
                PathBuf::from("/app/orgs/other-org/public"),
            ]
        );
    }

    /// The sweep force-unmounts, so scoping is the only thing standing between
    /// it and someone else's filesystem.
    #[test]
    fn never_touches_a_mount_outside_the_orgs_root() {
        let table = concat!(
            "localhost:/wd{x} on /app/sandboxes/h1/repo (nfs, nodev)\n",
            "server:/export on /Volumes/work (nfs, nodev)\n",
            "localhost:/wd{y} on /other-app/orgs/acme/home (nfs, nodev)\n",
        );
        assert!(stale_mountpoints(table, Path::new("/app")).is_empty());
    }

    #[test]
    fn ignores_non_nfs_filesystems_at_the_same_paths() {
        let table = concat!(
            "/dev/disk5 on /app/orgs/acme/home (apfs, local)\n",
            "devfs on /app/orgs/acme/uploads (devfs, local, nobrowse)\n",
        );
        assert!(stale_mountpoints(table, Path::new("/app")).is_empty());
    }

    /// A mountpoint may contain spaces — splitting the line on whitespace
    /// would truncate the path and unmount something else, or nothing.
    #[test]
    fn handles_mountpoints_containing_spaces() {
        let table = "localhost:/wd{z} on /app/orgs/my org/home (nfs, nodev)\n";
        assert_eq!(
            stale_mountpoints(table, Path::new("/app")),
            vec![PathBuf::from("/app/orgs/my org/home")]
        );
    }

    /// `public` holds the org's curated shared skill sets. The WebDAV surface
    /// already refuses writes to it; mounting it read-only is the second layer,
    /// so a bug in either one alone cannot corrupt shared content.
    /// The leak this exists for: `kill_on_drop` never fires on a hard exit, so
    /// rclone children outlive the app and pile up across restarts.
    #[test]
    fn finds_orphaned_rclone_servers_by_our_own_orgs_path() {
        let ps = concat!(
            " 100 /App.app/Contents/MacOS/rclone nfsmount wd: /data/orgs/deco/home --option x\n",
            " 101 /App.app/Contents/MacOS/rclone nfsmount wd: /data/orgs/acme/uploads\n",
        );
        assert_eq!(orphaned_rclone_pids(ps, "/data/orgs"), vec![100, 101]);
    }

    /// This SIGKILLs what it matches, so everything it must NOT match is the
    /// part worth pinning.
    #[test]
    fn never_kills_a_process_that_is_not_ours() {
        let ps = concat!(
            // The user's own rclone, serving their own backup.
            " 102 /usr/local/bin/rclone mount remote: /Users/me/backup\n",
            // Our app itself.
            " 103 /App.app/Contents/MacOS/decocms-desktop\n",
            // Something merely MENTIONING the path — a grep, an editor.
            " 104 grep -r rclone /data/orgs\n",
            // Another app's org mounts, same layout, different root.
            " 105 /Other.app/Contents/MacOS/rclone nfsmount wd: /elsewhere/orgs/deco/home\n",
        );
        assert!(orphaned_rclone_pids(ps, "/data/orgs").is_empty());
    }

    /// Concurrency: two sandbox ensures for one org must not each spawn their
    /// own rclone for the same mountpoint.
    #[test]
    fn only_one_mount_attempt_per_org_can_be_in_flight() {
        lock_states().remove("claim-org");
        assert!(claim("claim-org").is_some(), "first caller claims it");
        assert!(claim("claim-org").is_none(), "second is turned away");

        settle("claim-org", true);
        assert!(
            claim("claim-org").is_none(),
            "a ready org is not re-mounted"
        );
        lock_states().remove("claim-org");
    }

    /// The trap that made the request hook viable: this runs on EVERY
    /// org-scoped request, so a failing org must not be retried by each one —
    /// that is a spawn storm against an upstream that is already unhappy.
    #[test]
    fn a_failed_org_is_left_alone_until_its_cooldown_expires() {
        lock_states().remove("cooldown-org");
        claim("cooldown-org");
        settle("cooldown-org", false);
        assert!(claim("cooldown-org").is_none(), "still cooling off");

        // Once the cooldown passes, a fresh attempt is allowed.
        lock_states().insert(
            "cooldown-org".to_string(),
            MountState::Failed {
                until: Instant::now() - Duration::from_secs(1),
            },
        );
        assert!(
            claim("cooldown-org").is_some(),
            "retried after the cooldown"
        );
        lock_states().remove("cooldown-org");
    }

    #[test]
    fn public_volumes_mount_read_only() {
        assert!(is_read_only("public"));
        assert!(is_read_only("public-core"));
        for writable in ["home", "uploads", "outputs"] {
            assert!(!is_read_only(writable), "{writable} must stay writable");
        }
    }

    #[test]
    fn tolerates_lines_that_are_not_mount_entries() {
        for line in ["", "garbage", "no-separator (nfs)", "x on y"] {
            assert!(
                stale_mountpoints(line, Path::new("/app")).is_empty(),
                "{line:?}"
            );
        }
    }
}
