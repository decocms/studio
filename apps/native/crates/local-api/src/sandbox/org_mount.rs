//! Lifecycle of the shared org-filesystem mounts — `rclone nfsmount` on macOS,
//! `rclone mount` (FUSE) on Linux.
//!
//! The volumes are mounted once per organization under `<app_root>/orgs/<slug>`
//! and each sandbox links into them (see [`super::org_view`]). This module owns
//! the mounts themselves; P2 of `apps/native/docs/org-fs-plan.md`.
//!
//! ## Why a boot sweep exists at all
//!
//! A mount outlives the process that served it. When the app is SIGKILLed —
//! which happens routinely during development, and to any app the user force
//! quits — rclone dies but the kernel keeps the mount in its table, backed by
//! nothing. The directory is then unusable: on macOS the first access blocks
//! for about eight seconds and every later one fails instantly with
//! `ETIMEDOUT`, on Linux every access fails at once with `ENOTCONN`. Either
//! way the sandbox that owns it can never be re-provisioned at the same path.
//!
//! This is not theoretical. Before this module existed, a development machine
//! had accumulated **21** such ghosts from the previous TS `link` daemon, with
//! no `rclone` process alive to back any of them.
//!
//! Every unmount this runs is the LAZY variant and exits non-zero harmlessly
//! when the path is not a mount (see [`detach_commands`]) — so the sweep can
//! run unconditionally at boot without first proving anything about each entry.
//! Lazy bounds the KERNEL's half of the detach, not the helper's own: libfuse
//! stats the mountpoint before `umount2`, and against a FUSE server wedged in
//! uninterruptible sleep that stat never returns, so `fusermount3 -uz` never
//! exits either. Time is the only bound that holds there — hence
//! [`DETACH_COMMAND_TIMEOUT`] and [`MOUNT_ATTEMPT_TIMEOUT`].
//!
//! ## Why entries are keyed by mountpoint, never by source
//!
//! On macOS rclone derives its NFS export name from the remote plus a config
//! hash, so several distinct mounts share one source string: three different
//! mountpoints were observed all reporting `localhost:/wd{KnsWa}`. On Linux
//! the source is the remote name `wd:` for every volume of every org, which
//! collides even harder. Only the mountpoint identifies a mount, so only the
//! mountpoint decides what this sweeps.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::process::Command;

use crate::process_group::ProcessGroupChild;

use super::org_view::ORG_VOLUMES;

/// Whether this platform has an org-filesystem mount stack at all.
///
/// Windows has none: it would need WinFsp, a third-party kernel driver. Linux
/// additionally needs a `fusermount` helper on `PATH` at runtime — the bundled
/// rclone references both the fuse3 name (`fusermount3`) and the fuse2-era one
/// — but a host carrying neither fails the mount rather than this gate, which
/// the sandbox already handles as an empty `org/`.
const PLATFORM_SUPPORTED: bool = cfg!(any(target_os = "macos", target_os = "linux"));

/// Which of the two mount stacks this platform speaks: Linux FUSE (`rclone
/// mount`, `/proc/self/mounts`, `fusermount3`) or macOS NFS (`rclone
/// nfsmount`, the BSD `mount` table, `umount -f`).
///
/// Passed INTO the pure helpers below rather than read by them, so both
/// stacks' argv, table parsing and unmount chains are exercised by the unit
/// suite whichever host runs it — a macOS-only `cfg` would leave the Linux
/// halves unproven until they first ran on a user's machine.
const LINUX_MOUNT_STACK: bool = cfg!(target_os = "linux");

/// Set to anything to force the unsupported-platform path.
const DISABLE_ENV: &str = "DECOCMS_DISABLE_ORG_FS";

/// Whether to mount at all. The env var is the runtime escape: a wedged FUSE
/// mount, a host without `/dev/fuse`, or an unexpected rclone failure degrades
/// to the already-supported empty-`org/` path without waiting for a release.
fn org_fs_enabled() -> bool {
    org_fs_enabled_for(PLATFORM_SUPPORTED, std::env::var_os(DISABLE_ENV).is_some())
}

/// Split out so the matrix is testable without mutating this process's
/// environment, which no test may do under cargo's in-process parallel
/// harness.
fn org_fs_enabled_for(platform_supported: bool, disabled: bool) -> bool {
    platform_supported && !disabled
}

/// What a non-browser client in this process needs to satisfy local-api's own
/// guard.
///
/// A bearer is NOT sufficient: the shipped app runs embedded, where the guard
/// wants the exact `Host`, the exact `Origin` on unsafe methods (and
/// `PROPFIND` is unsafe — rclone sends no `Origin` by default), and a
/// credential. Without all three, listing fails with
/// `couldn't list files: forbidden origin: 403`.
///
/// `rclone` gets [`Self::mount_token`], which the guard accepts on
/// `/_sandbox/orgfs/*` and nowhere else. Agent terminals mint their own
/// per-session MCP capabilities and use this structure only to discover the
/// local endpoint and CA certificate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MountCredentials {
    /// `http://<exact expected host>` — the host string must match what the
    /// guard compares against, byte for byte, or every request is rejected.
    pub base_url: String,
    pub origin: String,
    /// The org-filesystem-only credential — see
    /// [`crate::client_auth::MOUNT_TOKEN_HEADER`].
    pub mount_token: String,
    /// The root [`Self::base_url`]'s certificate chains to, when the listener
    /// serves TLS. Alone it is only usable by a consumer that ADDS roots: the
    /// claude CLI is Bun/BoringSSL, reads nothing but its bundled Mozilla
    /// roots, and without this file its MCP connection to `base_url` fails
    /// TLS outright. On macOS nothing else needs it — rclone (Go) and codex
    /// (rustls-platform-verifier) both consult the keychain, where this root
    /// is installed. Where no OS trust store carries it, those two are served
    /// by [`Self::ca_bundle`] instead.
    pub ca_cert: Option<PathBuf>,
    /// A store containing every PUBLIC root plus [`Self::ca_cert`], for
    /// consumers that only accept a REPLACEMENT store (`SSL_CERT_FILE`).
    /// `None` unless such a superset could actually be built — see
    /// `src-tauri/src/local_tls.rs`'s `ensure_child_ca_bundle`.
    pub ca_bundle: Option<PathBuf>,
}

fn credentials_cell() -> &'static OnceLock<MountCredentials> {
    static CREDENTIALS: OnceLock<MountCredentials> = OnceLock::new();
    &CREDENTIALS
}

/// The published endpoint and mount credential for loopback child processes.
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
/// They are RETAINED here on purpose: dropping one tears down the mount it
/// is serving. Each is a [`ProcessGroupChild`] anchored to the app-wide
/// child-lifetime fence, so an app that dies WITHOUT dropping them — SIGKILL,
/// the dev loop's rebuild — still gets its rclone reaped by the watchdog
/// instead of leaving an orphan serving a stale-credential mount. Exactly
/// such an orphan (from a boot whose mount token had long rotated) once made
/// a later boot's mount table lie, and every "write to the org fs" landed on
/// the raw directory underneath — see [`mount_all`]'s ownership matrix.
fn children() -> &'static Mutex<HashMap<PathBuf, ProcessGroupChild>> {
    static CHILDREN: OnceLock<Mutex<HashMap<PathBuf, ProcessGroupChild>>> = OnceLock::new();
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// What [`mount_all`] must do for one volume, given who owns what.
///
/// "Owned" is OUR live [`ProcessGroupChild`] for the mountpoint; "attached"
/// is the kernel mount table. The two agree only in the healthy case, and
/// every disagreement has a distinct repair:
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MountPlan {
    /// Ours and attached — leave it alone.
    Keep,
    /// Attached but NOT ours: a ghost from another app generation. Its
    /// backing server (if any) holds credentials from a dead boot, so every
    /// call it proxies fails; trusting the table here is how a volume ends
    /// up unmounted-in-practice while marked mounted. Reclaim the path,
    /// then spawn fresh.
    ReclaimGhostThenSpawn,
    /// Ours but NOT attached: the child died or its mount was pulled from
    /// under it. Reap what is left, then spawn fresh.
    ReapOwnThenSpawn,
    /// Neither — plain spawn.
    Spawn,
}

fn mount_plan(owned: bool, attached: bool) -> MountPlan {
    match (owned, attached) {
        (true, true) => MountPlan::Keep,
        (false, true) => MountPlan::ReclaimGhostThenSpawn,
        (true, false) => MountPlan::ReapOwnThenSpawn,
        (false, false) => MountPlan::Spawn,
    }
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
    ///
    /// How far out `until` sits depends on WHICH failure: a completed attempt
    /// gets the flat [`FAILURE_COOLDOWN`], an ABANDONED one a growing wait —
    /// see [`settle_attempt`].
    Failed { until: Instant },
}

/// How long a failed org is left alone before another attempt, and the first
/// step of the abandoned-attempt backoff.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

/// The ceiling on that backoff. An org whose mount keeps being abandoned is
/// worth one or two more tries an hour — each costs a blocking thread (see
/// [`Attempt::Abandoned`]) and the wedge usually outlives the process.
const ABANDONED_COOLDOWN_CAP: Duration = Duration::from_secs(60 * 60);

/// How many consecutive abandoned attempts before an org is left alone for the
/// life of the process. Reaching [`ABANDONED_COOLDOWN_CAP`] takes eight, so
/// this spends four more there — roughly five hours and a dozen stranded
/// threads — before treating the server as wedged rather than slow. Backing off
/// alone only slows the leak: the pool is finite and shared, so an unbounded
/// retry still exhausts it, just later. A server that has stopped answering
/// syscalls is reclaimed by [`prune_stale_mounts`] at the next boot, not by
/// another attempt inside this one.
const ABANDONED_ATTEMPT_CEILING: u32 = 12;

/// The cooldown past that ceiling: longer than any app session, so the org is
/// simply not tried again. Expressed as a cooldown rather than a new
/// [`MountState`] so `claim`'s and `settle`'s logic stay exactly as they were.
const WEDGED_COOLDOWN: Duration = Duration::from_secs(365 * 24 * 60 * 60);

/// How long [`wait_ready`] blocks a sandbox ensure on a mount that is not up
/// yet. Short on purpose: with warm mounts this never elapses, so it only
/// matters when something is broken — exactly when blocking provisioning is
/// the wrong trade. The sandbox proceeds with an empty view and says so.
pub const READY_TIMEOUT: Duration = Duration::from_secs(2);

/// How long one unmount command gets before it is abandoned for the next in
/// the chain.
///
/// The lazy flags bound the kernel's detach, not the helper's pre-flight `stat`
/// of the mountpoint: against a FUSE server wedged in uninterruptible sleep
/// that stat never returns, so the command never exits at all. Unbounded, one
/// such path pins its org in [`MountState::InFlight`] — which [`claim`] never
/// releases — for the rest of the process's life. Five seconds mirrors the
/// daemon this ports from (`packages/sandbox/daemon/org-fs/detach-mount.ts`).
const DETACH_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);

/// How long one org's whole mount attempt gets before it is abandoned.
///
/// Bounding each command is not enough: [`mount_all`] also calls
/// `create_dir_all` on the mountpoint, which blocks in the same uninterruptible
/// sleep against the same wedged server. ANY hang there is absorbing, so the
/// bound has to wrap the whole attempt for [`settle`] to be reachable.
///
/// Sized against the worst LEGITIMATE run — four volumes, each possibly a full
/// detach chain plus the attach wait — because elapsing early strands a
/// blocking thread (see [`Attempt::Abandoned`]) while not elapsing costs the
/// org forever.
const MOUNT_ATTEMPT_TIMEOUT: Duration = Duration::from_secs(120);

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

/// Consecutive attempts abandoned by [`MOUNT_ATTEMPT_TIMEOUT`], per org.
///
/// Beside [`states`] rather than inside [`MountState::Failed`] because [`claim`]
/// replaces that state with [`MountState::InFlight`] for exactly the span of the
/// attempt this counts — a count cannot live in the state it has to outlive.
/// Only a volume that actually attached clears it.
fn abandoned_attempts() -> &'static Mutex<HashMap<String, u32>> {
    static ABANDONED: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    ABANDONED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_abandoned() -> std::sync::MutexGuard<'static, HashMap<String, u32>> {
    abandoned_attempts()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Count one abandoned attempt, answering how many in a row that makes.
fn record_abandoned(org_slug: &str) -> u32 {
    let mut abandoned = lock_abandoned();
    let nth = abandoned
        .get(org_slug)
        .copied()
        .unwrap_or(0)
        .saturating_add(1);
    abandoned.insert(org_slug.to_string(), nth);
    nth
}

/// Forget an org's abandoned attempts: a volume that attached proves its server
/// answers syscalls again.
fn clear_abandoned(org_slug: &str) {
    lock_abandoned().remove(org_slug);
}

/// Record how one bounded attempt ended, and with it when the org may be tried
/// again.
///
/// Only [`Attempt::Abandoned`] backs off, and it has to: [`warm`] runs on EVERY
/// org-scoped request, so at a flat [`FAILURE_COOLDOWN`] a wedged org strands
/// one more blocking thread every `MOUNT_ATTEMPT_TIMEOUT + FAILURE_COOLDOWN` —
/// twenty-odd an hour, for as long as the app runs, out of ONE pool of 512 that
/// every `tokio::fs` call in this process shares and whose exhaustion stalls all
/// of them. Doubling to [`ABANDONED_COOLDOWN_CAP`] instead costs eight threads
/// climbing to the cap and one or two an hour after it, and
/// [`ABANDONED_ATTEMPT_CEILING`] stops it there — together they keep the
/// recovery the bound was added for at a fixed cost.
///
/// [`Attempt::Failed`] strands nothing, so it keeps the cooldown it always had.
fn settle_attempt(org_slug: &str, outcome: Attempt) {
    match outcome {
        Attempt::Mounted => {
            clear_abandoned(org_slug);
            settle(org_slug, true);
        }
        Attempt::Failed => settle(org_slug, false),
        Attempt::Abandoned => {
            let cooldown = abandoned_cooldown(record_abandoned(org_slug), rand::random::<f64>());
            lock_states().insert(
                org_slug.to_string(),
                MountState::Failed {
                    until: Instant::now() + cooldown,
                },
            );
        }
    }
}

/// How long to leave an org alone after its `nth` consecutive abandoned attempt
/// (`1` being the first): [`FAILURE_COOLDOWN`] doubled each time up to
/// [`ABANDONED_COOLDOWN_CAP`], less a jitter of up to half of it so several orgs
/// that wedged together do not come back in lockstep — and then
/// [`WEDGED_COOLDOWN`] once [`ABANDONED_ATTEMPT_CEILING`] is reached, which is
/// what keeps the stranded threads a fixed cost rather than a slower leak.
fn abandoned_cooldown(nth: u32, sample: f64) -> Duration {
    if nth >= ABANDONED_ATTEMPT_CEILING {
        return WEDGED_COOLDOWN;
    }
    exponential_backoff_with_jitter(
        ABANDONED_COOLDOWN_CAP,
        FAILURE_COOLDOWN,
        nth.saturating_sub(1),
        2.0,
        0.5,
        sample,
    )
}

/// `base * multiplier^attempt`, capped at `cap`, then shortened by `jitter`
/// times `sample` of itself.
///
/// The repo's canonical `exponentialBackoffWithJitter` (`@decocms/shared/std`)
/// is TypeScript and unreachable from this crate; this is that same formula,
/// with the random draw passed IN so the growth is provable without one. A
/// `jitter` of `0` never shortens, `0.5` yields `[exp/2, exp]`, `1` yields
/// `[0, exp]`.
fn exponential_backoff_with_jitter(
    cap: Duration,
    base: Duration,
    attempt: u32,
    multiplier: f64,
    jitter: f64,
    sample: f64,
) -> Duration {
    let attempt = i32::try_from(attempt).unwrap_or(i32::MAX);
    let exp = (base.as_secs_f64() * multiplier.powi(attempt)).min(cap.as_secs_f64());
    let delay = exp * (1.0 - jitter.clamp(0.0, 1.0) * sample.clamp(0.0, 1.0));
    // A delay no duration can express — a draw that is not a number, an
    // infinity — is the cap and never a panic: this runs on the mount task, and
    // waiting too long only costs one retry.
    Duration::try_from_secs_f64(delay).unwrap_or(cap)
}

/// Start mounting an organization's volumes, without waiting for them.
///
/// Called when the app first touches an org — which is both "the app booted
/// into this org" and "the user switched to it" — so the mounts are warming
/// while the user is still navigating to an agent. Cheap and idempotent: an
/// org that is ready, in flight, or cooling off returns immediately.
///
/// Where [`org_fs_enabled`] is false this does nothing at all — no task, no
/// claim — so the state map stays empty and every sandbox takes the
/// empty-`org/` path it already handles.
pub fn warm(app_root: &Path, org_slug: &str) {
    if !org_fs_enabled() {
        return;
    }
    if claim(org_slug).is_none() {
        return;
    }
    let app_root = app_root.to_path_buf();
    let org = org_slug.to_string();
    tokio::spawn(async move {
        let outcome = attempt_mount(MOUNT_ATTEMPT_TIMEOUT, mount_all(&app_root, &org)).await;
        settle_attempt(&org, outcome);
    });
}

/// How one bounded mount attempt ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Attempt {
    /// Every volume attached.
    Mounted,
    /// The attempt ran to completion with at least one volume still down. It
    /// left nothing of itself behind.
    Failed,
    /// The bound elapsed with the attempt still running — NOT a synonym for
    /// [`Self::Failed`].
    ///
    /// `tokio::time::timeout` frees the TASK, never the thread a
    /// `spawn_blocking` is parked in, and every `tokio::fs` call is one —
    /// including the `create_dir_all` [`mount_all`] runs on a mountpoint whose
    /// FUSE server is wedged in uninterruptible sleep. That thread never
    /// returns to the process-wide blocking pool, so this outcome costs
    /// something a plain failure does not and [`settle_attempt`] rations it.
    Abandoned,
}

/// Run one org's mount attempt under `bound`, counting a hang as a failure of
/// its own kind.
///
/// The bound and the attempt are parameters because what they exist for — a
/// syscall against a wedged mount that never returns — has no reproducible
/// stand-in. An attempt that never finishes must still settle: [`MountState::InFlight`]
/// is the state machine's absorbing one, so an org left in it is refused by
/// [`claim`] for the rest of the process's life and every [`wait_ready`] for it
/// burns the whole [`READY_TIMEOUT`] to reach the same answer.
async fn attempt_mount<Fut>(bound: Duration, attempt: Fut) -> Attempt
where
    Fut: std::future::Future<Output = bool>,
{
    match tokio::time::timeout(bound, attempt).await {
        Ok(true) => Attempt::Mounted,
        Ok(false) => Attempt::Failed,
        Err(_elapsed) => Attempt::Abandoned,
    }
}

/// Wait for an organization's volumes to be attached, up to
/// [`READY_TIMEOUT`].
///
/// Returns whether they are. Starts the mount itself if nothing has — a
/// sandbox can be ensured without any org-scoped request having preceded it
/// (a resurrect on boot, a test), and such a caller must not wait out the
/// timeout for something nobody started.
pub async fn wait_ready(app_root: &Path, org_slug: &str) -> bool {
    wait_ready_when(app_root, org_slug, org_fs_enabled()).await
}

/// [`wait_ready`] with the platform gate passed in, so the disabled path is
/// testable on a host where org-fs is supported.
async fn wait_ready_when(app_root: &Path, org_slug: &str, enabled: bool) -> bool {
    // Answered here rather than by the loop below: nothing writes a state for
    // this org when the gate is off, and an absent state means "keep waiting"
    // (see the loop's own comment), so falling through would burn the whole
    // [`READY_TIMEOUT`] on every sandbox ensure to reach the same `false`.
    if !enabled {
        return false;
    }
    warm(app_root, org_slug);
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match lock_states().get(org_slug).copied() {
            Some(MountState::Ready) => return true,
            Some(MountState::Failed { .. }) => return false,
            // `None` is NOT failure — it is "no outcome recorded yet". `warm`
            // above spawns the mount, so between that spawn and its first
            // state write there is a window where the entry is absent;
            // treating it as failure made a caller that landed in that window
            // report "NOT mounted" for a filesystem that was mounting fine,
            // directly contradicting the `ready` line a sibling call had just
            // printed. Keep waiting; the deadline below is the only failure.
            None | Some(MountState::InFlight) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The bundled rclone.
///
/// Tauri appends the host triple when resolving an `externalBin` and strips it
/// again when copying into the bundle — `<App>.app/Contents/MacOS/` on macOS,
/// the AppDir's `usr/bin/` on Linux — so on both the packaged binary sits
/// beside the app executable, inside the mounted squashfs in the AppImage's
/// case. The triple-suffixed path is the `tauri dev` fallback, where nothing
/// has been copied yet.
fn rclone_binary() -> Option<PathBuf> {
    #[cfg(feature = "e2e-runner")]
    if std::env::var_os("LOCAL_API_E2E_DISABLE_ORG_MOUNTS").as_deref()
        == Some(std::ffi::OsStr::new("1"))
    {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.join("rclone");
    if bundled.is_file() {
        return Some(bundled);
    }
    let dev = dir.join(dev_rclone_name(LINUX_MOUNT_STACK, std::env::consts::ARCH));
    dev.is_file().then_some(dev)
}

/// What `scripts/fetch-rclone.sh` names its download: the full Rust host
/// triple, whose architecture half is exactly `std::env::consts::ARCH`
/// (`aarch64`/`x86_64`) on both platforms.
fn dev_rclone_name(linux: bool, arch: &str) -> String {
    let vendor_and_os = if linux {
        "unknown-linux-gnu"
    } else {
        "apple-darwin"
    };
    format!("rclone-{arch}-{vendor_and_os}")
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

    let attached = attached_mountpoints().await;
    let lock_path = crate::shared_child_lifetime_lock_path(app_root);
    let mut all = true;
    for volume in ORG_VOLUMES {
        let mountpoint = root.join(volume);
        let owned = children()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains_key(&mountpoint);
        match mount_plan(owned, attached.contains(&mountpoint)) {
            MountPlan::Keep => continue,
            MountPlan::ReclaimGhostThenSpawn => {
                tracing::warn!(
                    ?mountpoint,
                    "reclaiming an org mount this process does not own"
                );
                force_unmount(&mountpoint).await;
            }
            MountPlan::ReapOwnThenSpawn => {
                let child = children()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(&mountpoint);
                if let Some(mut child) = child {
                    tracing::warn!(?mountpoint, "org mount lost its attachment; replacing it");
                    child
                        .kill_and_reap(Duration::from_secs(5), "org-fs mount replace")
                        .await;
                }
            }
            MountPlan::Spawn => {}
        }
        if let Err(error) = tokio::fs::create_dir_all(&mountpoint).await {
            tracing::warn!(%error, ?mountpoint, "could not create org mountpoint");
            all = false;
            continue;
        }
        let config = match write_rclone_config(app_root, org_slug, volume, creds).await {
            Ok(config) => config,
            Err(error) => {
                tracing::warn!(%error, org_slug, volume, "could not write rclone config");
                all = false;
                continue;
            }
        };
        match spawn_mount(
            &bin,
            &config,
            &mountpoint,
            volume,
            &lock_path,
            creds.ca_bundle.as_deref(),
        )
        .await
        {
            Ok(child) => {
                children()
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .insert(mountpoint.clone(), child);
                if !wait_until_mounted(&mountpoint).await {
                    // With the type, because "rclone attached under a name this
                    // module does not recognise" and "rclone never attached"
                    // are otherwise the same line, and only the first is
                    // diagnosable from it.
                    let fstype = observed_fstype(&mountpoint).await;
                    tracing::warn!(
                        ?mountpoint,
                        fstype = fstype.as_deref().unwrap_or("<not a mountpoint>"),
                        "org volume did not attach in time"
                    );
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

/// The rclone remote definition for one volume, written to a private file.
///
/// NOT the environment and NOT argv. A process's environment is readable by
/// anything running as the same uid — `ps -Eww` on macOS, `/proc/<pid>/environ`
/// on Linux — and every sandbox harness this app spawns runs as that uid, so an
/// env var is no more private than argv here. A `0600` file the caller owns is
/// the narrowest channel available to a child that can only be configured by
/// file or env.
///
/// The remote's URL is not secret and could stay on the command line; keeping
/// it in the same file just means one shape to reason about.
async fn write_rclone_config(
    app_root: &Path,
    org: &str,
    volume: &str,
    creds: &MountCredentials,
) -> std::io::Result<PathBuf> {
    let dir = app_root.join(".decocms").join("rclone").join(org);
    tokio::fs::create_dir_all(&dir).await?;
    restrict(&dir, 0o700).await?;
    let path = dir.join(format!("{volume}.conf"));
    // Truncating first, then restricting, then writing: the file must never
    // exist as group/world-readable WITH the token already in it.
    tokio::fs::write(&path, b"").await?;
    restrict(&path, 0o600).await?;
    let body = format!(
        "[wd]\ntype = webdav\nurl = {}/_sandbox/orgfs/{org}/{volume}\nvendor = other\nheaders = Origin,{},{},{}\n",
        creds.base_url,
        creds.origin,
        crate::client_auth::MOUNT_TOKEN_HEADER,
        creds.mount_token,
    );
    tokio::fs::write(&path, body).await?;
    Ok(path)
}

#[cfg(unix)]
async fn restrict(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).await
}

#[cfg(not(unix))]
async fn restrict(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// The macOS NFS client options, as one comma-joined `--option` value.
///
/// `actimeo=1` holds the kernel's attribute cache to a second — its 5-second
/// default outlives a write made through the WebDAV surface; `locallocks`
/// because rclone's NFS server speaks no NLM, so locking has to stay in this
/// client; `soft` with `timeo`/`retrans` bounds a dead server to roughly two
/// seconds instead of an unkillable hang; `nobrowse` keeps the volume out of
/// Finder.
const MACOS_NFS_OPTIONS: &str = "actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse";

/// The flags both stacks pass, in one place so they cannot drift apart.
const SHARED_MOUNT_ARGS: [&str; 12] = [
    "--vfs-cache-mode",
    "full",
    "--vfs-write-back",
    "1s",
    "--dir-cache-time",
    "10s",
    // rclone's DEFAULTS are unusable here: its VFS downloader retries to a
    // hard-coded 10-error limit, so `--timeout` x `--low-level-retries` x 11
    // is the worst-case block when the backing server stops answering — about
    // NINE HOURS at the defaults. On loopback a request is either instant or
    // dead, so bound it aggressively.
    "--timeout",
    "5s",
    "--contimeout",
    "3s",
    "--low-level-retries",
    "1",
];

/// The rclone argv for one volume, without the binary.
///
/// The two stacks differ only in the subcommand and in how each kernel is told
/// to hold attributes for a second — everything after that is
/// [`SHARED_MOUNT_ARGS`], so a change to the VFS or timeout behaviour cannot
/// land on one platform alone.
///
/// No `--allow-other` on Linux: that is for a mount whose reader runs under a
/// different uid (the cluster sidecar's case), and it additionally requires
/// `user_allow_other` in the root-owned `/etc/fuse.conf` — without which
/// libfuse refuses the mount outright. A desktop mounts and reads as one uid.
fn mount_args(linux: bool, config: &Path, mountpoint: &Path, volume: &str) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["--config".into(), config.into()];
    args.push(if linux { "mount" } else { "nfsmount" }.into());
    args.push("wd:".into());
    args.push(mountpoint.into());
    let attribute_cache: [&str; 2] = if linux {
        ["--attr-timeout", "1s"]
    } else {
        ["--option", MACOS_NFS_OPTIONS]
    };
    args.extend(attribute_cache.into_iter().map(OsString::from));
    args.extend(SHARED_MOUNT_ARGS.into_iter().map(OsString::from));
    // One more layer under the WebDAV surface's own write refusal — the
    // shared predicate lives beside `ORG_VOLUMES` so the two layers cannot
    // disagree about which volumes those are.
    if super::org_view::is_read_only_volume(volume) {
        args.push("--read-only".into());
        if linux {
            // rclone's FUSE files default to 0666 minus the umask — no execute
            // bit — and the org filesystem carries no mode bits of its own to
            // supply one, so a public skill set's helper script would arrive
            // unrunnable. macOS keeps the argv it has shipped with.
            args.extend(["--file-perms", "0755"].into_iter().map(OsString::from));
        }
    }
    args
}

/// Spawn a supervised `rclone` mount for one volume.
///
/// Foreground, never `--daemon`: it is broken in rclone on both stacks —
/// `nfsmount --daemon --rc` exits 1 rather than attaching, and `mount --daemon
/// --rc` hangs without attaching (`packages/sandbox/daemon/org-fs/mounter.ts`)
/// — so the child has to be supervised here.
///
/// Nothing secret is passed here at all — see [`write_rclone_config`].
///
/// `ca_bundle` is a SUPERSET store (public roots + ours) or nothing: rclone is
/// Go, and Go reads `SSL_CERT_FILE` as a REPLACEMENT for the system roots, so
/// a local-CA-only file here would take the public internet away from a
/// process that also talks to remote backends. It is `None` on macOS, where
/// the keychain already carries the local root, and on a Linux host with no
/// system store to build the superset FROM — there rclone cannot verify this
/// app's own HTTPS listener, so the volume fails to mount and reads as an
/// empty directory rather than mounting unverified.
async fn spawn_mount(
    bin: &Path,
    config: &Path,
    mountpoint: &Path,
    volume: &str,
    lifetime_lock: &Path,
    ca_bundle: Option<&Path>,
) -> std::io::Result<ProcessGroupChild> {
    let mut cmd = Command::new(bin);
    if let Some(ca_bundle) = ca_bundle {
        cmd.env("SSL_CERT_FILE", ca_bundle);
    }
    cmd.args(mount_args(LINUX_MOUNT_STACK, config, mountpoint, volume))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // Anchored to the app-wide fence like every other spawned child:
    // `kill_on_drop` never fires for a SIGKILLed parent (or for a static the
    // process never drops), and an orphaned rclone is worse than most orphans
    // — it keeps a mount alive that authenticates with a dead boot's rotated
    // token, so the mount LOOKS attached while every operation through it
    // fails.
    ProcessGroupChild::spawn(&mut cmd, lifetime_lock).await
}

/// Wait for the kernel to actually attach the mount.
///
/// The mount TABLE is the authoritative signal. rclone's `rc` API reports
/// ready about 36 ms before the kernel attaches, so trusting it would hand
/// out a path that is not yet a mount.
async fn wait_until_mounted(mountpoint: &Path) -> bool {
    for _ in 0..40 {
        if attached_mountpoints()
            .await
            .contains(&mountpoint.to_path_buf())
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    false
}

/// `/proc/self/mounts`, never `/proc/mounts`: the two differ inside a mount
/// namespace, and what this process can unmount is what this process can see.
const PROC_MOUNTS: &str = "/proc/self/mounts";

/// The kernel's own mount table, in this platform's dialect.
///
/// Linux reads the file rather than shelling out to `mount(8)`:
/// [`wait_until_mounted`] consults this up to 40 times per volume, and a
/// subprocess per poll is a cost a file read does not have. macOS has no such
/// file.
async fn mounted_table() -> Option<String> {
    if LINUX_MOUNT_STACK {
        let table = tokio::fs::read(PROC_MOUNTS).await.ok()?;
        return Some(String::from_utf8_lossy(&table).into_owned());
    }
    let output = Command::new("mount")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Every path the kernel currently reports as a mountpoint, whatever its
/// filesystem type.
///
/// Deliberately NOT filtered by [`is_org_fstype`]. This answers "is our own
/// mountpoint attached?", where the path is already ours, so a type test buys
/// nothing and its failure mode is unrecoverable: an rclone that registers as
/// anything else — a different backend, a libfuse build that drops `subtype=`,
/// a non-UTF-8 path the lossily-decoded table no longer spells the same way —
/// reads as unattached, so the next cycle kills a WORKING rclone,
/// `create_dir_all` then fails `ENOTCONN`, and every cycle after that repeats
/// it. The ghost it leaves is invisible to the sweep, which filters by the same
/// predicate. The type test belongs only where a mistake means a mount is left
/// alone: [`stale_mountpoints`].
async fn attached_mountpoints() -> Vec<PathBuf> {
    let Some(table) = mounted_table().await else {
        return Vec::new();
    };
    table_mountpoints(LINUX_MOUNT_STACK, &table)
}

/// The filesystem type the kernel reports at `mountpoint`, for the one log line
/// a volume that never appeared leaves behind.
async fn observed_fstype(mountpoint: &Path) -> Option<String> {
    let table = mounted_table().await?;
    fstype_at(LINUX_MOUNT_STACK, &table, mountpoint)
}

/// Reclaim every stale org mount left behind by a previous run.
///
/// Best-effort: a path that is not actually mounted simply fails to unmount,
/// which costs one process and nothing else. Scoped to `<app_root>/orgs/` so
/// it can never touch a mount this app does not own.
///
/// Behind the same gate as the mounts themselves rather than the platform
/// alone: this is the half that force-unmounts and SIGKILLs, so the escape a
/// user reaches for when that is what went wrong has to stop it too.
pub async fn prune_stale_mounts(app_root: &Path) {
    match prune_stale_mounts_when(app_root, org_fs_enabled()).await {
        Sweep::Ran { reclaimed } => tracing::debug!(reclaimed, "org-fs boot sweep finished"),
        Sweep::Skipped => tracing::debug!("org-fs boot sweep skipped: org filesystem disabled"),
    }
}

/// What one boot sweep did.
///
/// [`Sweep::Skipped`] separates "looked and found nothing" from "never looked",
/// which is the distinction a user who reached for [`DISABLE_ENV`] needs from a
/// log — and it is reachable only from the gate, before the mount table is read
/// or any process is spawned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sweep {
    Skipped,
    Ran { reclaimed: usize },
}

/// [`prune_stale_mounts`] with the gate passed in, so the disabled path is
/// testable without mutating this process's environment, which no test may do
/// under cargo's in-process parallel harness.
async fn prune_stale_mounts_when(app_root: &Path, enabled: bool) -> Sweep {
    if !enabled {
        return Sweep::Skipped;
    }
    let Some(table) = mounted_table().await else {
        return Sweep::Ran { reclaimed: 0 };
    };
    // Kill the servers BEFORE reclaiming their mountpoints: an orphan still
    // answering for one can keep it busy, and once its path is unmounted it has
    // nothing left to serve anyway.
    kill_orphaned_servers(app_root).await;

    let mut reclaimed = 0;
    for mountpoint in stale_mountpoints(&table, app_root) {
        if force_unmount(&mountpoint).await {
            reclaimed += 1;
        }
    }
    Sweep::Ran { reclaimed }
}

/// The unmount commands to try, in order, until one exits 0.
///
/// Every variant is the LAZY one (`-f` on macOS, `-uz`/`-l` on Linux): the
/// blocking forms wait in-kernel for the server to flush, and the paths this is
/// called on are exactly the ones whose server is already gone. That bounds the
/// kernel's half only — the helper still stats the mountpoint first — so
/// [`force_unmount`] bounds each of these in time as well.
///
/// Linux needs a chain because the binary that owns an unprivileged FUSE
/// unmount varies: `fusermount3` ships with fuse3 and is the name rclone's own
/// mount helper reaches for first; `fusermount` is the fuse2-era name some
/// distros still carry, and which the same bundled binary also references;
/// `umount` is the last resort and generally wants privileges.
///
/// The mountpoint argument is the ONE macOS argv here that is not what shipped:
/// it used to be spelled `to_string_lossy`, so a path that is not valid UTF-8
/// reached `umount -f` with U+FFFD standing in for the real bytes — naming a
/// path that does not exist, leaving the actual ghost attached with nothing able
/// to reclaim it. Passing the `OsString` through verbatim is a deliberate change
/// on both platforms; the mount argv ([`mount_args`]) is untouched.
fn detach_commands(linux: bool, mountpoint: &Path) -> Vec<Vec<OsString>> {
    // Not `to_string_lossy`: a mountpoint that is not valid UTF-8 must reach
    // the unmount verbatim or the wrong path is reclaimed, or none is.
    let path = mountpoint.as_os_str().to_os_string();
    let command = |program: &str, flag: &str| -> Vec<OsString> {
        vec![program.into(), flag.into(), path.clone()]
    };
    if linux {
        vec![
            command("fusermount3", "-uz"),
            command("fusermount", "-uz"),
            command("umount", "-l"),
        ]
    } else {
        vec![command("umount", "-f")]
    }
}

/// Unmount one path, reporting whether it was reclaimed. Best-effort: a path
/// that is not actually mounted simply fails to unmount, which costs one
/// process per command and nothing else.
async fn force_unmount(mountpoint: &Path) -> bool {
    let commands = detach_commands(LINUX_MOUNT_STACK, mountpoint);
    if detach_chain(commands, DETACH_COMMAND_TIMEOUT, run_detach_command).await {
        tracing::info!(mountpoint = %mountpoint.display(), "reclaimed a stale org mount");
        return true;
    }
    // Not mounted after all, held by something, or wedged past the timeout: the
    // next attempt tries again, and a sandbox that needs the path reports it.
    tracing::debug!(mountpoint = %mountpoint.display(), "stale org mount did not unmount");
    false
}

/// Try each command in turn until one reports success, giving each at most
/// `per_command`.
///
/// The runner and the bound are parameters because what they exist for — a
/// command that never exits, because libfuse's pre-flight stat of a wedged
/// mountpoint never returns — cannot be staged with a real unmount. Elapsing
/// counts as failure, so an abandoned command falls through to the next exactly
/// as a non-zero exit does.
async fn detach_chain<Run, Fut>(
    commands: Vec<Vec<OsString>>,
    per_command: Duration,
    run: Run,
) -> bool
where
    Run: Fn(Vec<OsString>) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    for command in commands {
        if matches!(
            tokio::time::timeout(per_command, run(command)).await,
            Ok(true)
        ) {
            return true;
        }
    }
    false
}

/// Spawn one unmount command and report whether it exited 0.
///
/// Dropping this future — which is what a timeout does — kills the child it
/// spawned (`kill_on_drop`), so an abandoned command leaves nothing behind.
async fn run_detach_command(command: Vec<OsString>) -> bool {
    let Some((program, args)) = command.split_first() else {
        return false;
    };
    let status = tokio::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    matches!(status, Ok(status) if status.success())
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
    let Some(marker) = orgs_argv_marker(app_root) else {
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

/// The argv substring that identifies an org mount as OURS.
///
/// The trailing separator `join("")` appends is what anchors it at a path
/// boundary. This is matched as a raw substring against another process's
/// command line and this SIGKILLs what it matches, so an unanchored
/// `<app_root>/orgs` would also match `<app_root>/orgs-backup` — a directory
/// that is the user's, not ours. Our own argv is always
/// `<marker><slug>/<volume>`, so the separator excludes that class at no cost.
fn orgs_argv_marker(app_root: &Path) -> Option<String> {
    app_root.join("orgs").join("").to_str().map(str::to_string)
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
        //
        // `mount wd:` covers both stacks with one substring — macOS argv reads
        // `nfsmount wd:`, which contains it — and stays narrow because `wd:`
        // is OUR remote name, so a user's own `rclone mount remote:` is not a
        // match. What keeps their `rclone mount wd:` under a directory of
        // their own out of this list is the marker's own path boundary; see
        // [`orgs_argv_marker`].
        .filter(|line| {
            line.contains(marker) && line.contains("rclone") && line.contains("mount wd:")
        })
        .filter_map(|line| line.split_whitespace().next()?.parse::<i32>().ok())
        .collect()
}

/// The org mountpoints under `<app_root>/orgs/` named in a mount table.
///
/// Kept pure so the parsing — the part that can silently sweep the wrong path
/// — is testable without mounting anything.
fn stale_mountpoints(table: &str, app_root: &Path) -> Vec<PathBuf> {
    stale_mountpoints_for(LINUX_MOUNT_STACK, table, app_root)
}

/// [`stale_mountpoints`] with the mount stack passed in, so both dialects are
/// testable from either host.
fn stale_mountpoints_for(linux: bool, table: &str, app_root: &Path) -> Vec<PathBuf> {
    let orgs_root = app_root.join("orgs");
    org_mountpoints(linux, table)
        .into_iter()
        .filter(|mountpoint| mountpoint.starts_with(&orgs_root))
        .collect()
}

/// Every `(mountpoint, fstype)` a mount table names, in this platform's
/// dialect.
fn mount_table_entries(linux: bool, table: &str) -> Vec<(PathBuf, String)> {
    table
        .lines()
        .filter_map(|line| {
            if linux {
                parse_proc_mounts_line(line)
            } else {
                parse_mount_line(line)
            }
        })
        .collect()
}

/// Every path a mount table names — the attachment question, which is about a
/// path and not about a filesystem type (see [`attached_mountpoints`]).
fn table_mountpoints(linux: bool, table: &str) -> Vec<PathBuf> {
    mount_table_entries(linux, table)
        .into_iter()
        .map(|(mountpoint, _)| mountpoint)
        .collect()
}

/// The filesystem type a mount table reports at `mountpoint`, if it names it.
fn fstype_at(linux: bool, table: &str, mountpoint: &Path) -> Option<String> {
    mount_table_entries(linux, table)
        .into_iter()
        .find(|(path, _)| path == mountpoint)
        .map(|(_, fstype)| fstype)
}

/// Every org mountpoint a mount table names, unscoped — the stale sweep's
/// candidates, and the only consumer of [`is_org_fstype`].
fn org_mountpoints(linux: bool, table: &str) -> Vec<PathBuf> {
    mount_table_entries(linux, table)
        .into_iter()
        .filter(|(_, fstype)| is_org_fstype(linux, fstype))
        .map(|(mountpoint, _)| mountpoint)
        .collect()
}

/// Whether a mount table's filesystem type names one of our own mounts.
///
/// A SAFETY SCOPE, not an identity: it gates what the sweep force-unmounts, so
/// it must stay narrow, and a false negative here only leaves a stale mount
/// attached. It must never gate whether OUR path is attached — see
/// [`attached_mountpoints`] for what that costs.
///
/// On Linux the type is `fuse` plus the `subtype=rclone` every rclone mount
/// backend passes, so it is matched by containment the way rclone's own
/// readiness check does (`cmd/mountlib/check_linux.go`) rather than by
/// equality — but still anchored to `fuse`, so a non-FUSE filesystem whose
/// name merely mentions rclone can never be swept.
fn is_org_fstype(linux: bool, fstype: &str) -> bool {
    if linux {
        fstype.starts_with("fuse") && fstype.contains("rclone")
    } else {
        fstype == "nfs"
    }
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

/// `<source> <mountpoint> <fstype> <opts> 0 0` — the `/proc/self/mounts`
/// format.
///
/// Exactly six single-space-separated fields, which is also what keeps a BSD
/// line from parsing here by accident. The source is discarded for the same
/// reason as above; it is `wd:` for every volume of every org.
fn parse_proc_mounts_line(line: &str) -> Option<(PathBuf, String)> {
    let fields: Vec<&str> = line.split(' ').collect();
    let [_source, mountpoint, fstype, _options, _dump, _pass] = fields[..] else {
        return None;
    };
    Some((
        PathBuf::from(unescape_octal(mountpoint)),
        unescape_octal(fstype),
    ))
}

/// Decode the kernel's `\NNN` escapes.
///
/// `/proc` separates fields with spaces, so it escapes space, tab, newline,
/// backslash — and `#` outside the mountpoint — as a backslash plus exactly
/// three octal digits. A mountpoint taken raw would therefore be truncated at
/// the first space, which is a path this module force-unmounts.
///
/// One left-to-right pass, never re-scanning its own output: `\134060` is a
/// literal backslash followed by `060`, not the `0` that decoding twice
/// would yield.
fn unescape_octal(field: &str) -> String {
    let bytes = field.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match octal_escape(bytes, index) {
            Some(byte) => {
                decoded.push(byte);
                index += 4;
            }
            None => {
                decoded.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The byte a `\NNN` escape at `index` stands for, if there is one there.
fn octal_escape(bytes: &[u8], index: usize) -> Option<u8> {
    if bytes.get(index).copied()? != b'\\' {
        return None;
    }
    let digits = bytes.get(index + 1..index + 4)?;
    let mut value: u16 = 0;
    for digit in digits {
        if !(b'0'..=b'7').contains(digit) {
            return None;
        }
        value = value * 8 + u16::from(digit - b'0');
    }
    u8::try_from(value).ok()
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

    /// The Linux equivalent: `/proc/self/mounts`, where every one of our mounts
    /// reports the same `wd:` source and the same `fuse.rclone` type, next to
    /// a foreign FUSE mount and an rclone mount that is the user's own.
    const PROC_TABLE: &str = concat!(
        "/dev/sda1 / ext4 rw,relatime 0 0\n",
        "wd: /app/orgs/acme/home fuse.rclone rw,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0\n",
        "wd: /app/orgs/acme/uploads fuse.rclone rw,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0\n",
        "wd: /app/orgs/other-org/public fuse.rclone ro,nosuid,nodev,relatime,user_id=1000,group_id=1000 0 0\n",
        "me@host:/srv /app/orgs/acme/borrowed fuse.sshfs rw,nosuid,nodev,relatime,user_id=1000 0 0\n",
        "gdrive: /home/me/drive fuse.rclone rw,nosuid,nodev,relatime,user_id=1000 0 0\n",
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

    /// The marker every `orphaned_rclone_pids` case is matched against — built
    /// the way production builds it, so the anchoring below is the real one.
    fn marker(app_root: &str) -> String {
        orgs_argv_marker(Path::new(app_root)).expect("a UTF-8 app root")
    }

    /// The leak this exists for: `kill_on_drop` never fires on a hard exit, so
    /// rclone children outlive the app and pile up across restarts.
    #[test]
    fn finds_orphaned_rclone_servers_by_our_own_orgs_path() {
        let ps = concat!(
            " 100 /App.app/Contents/MacOS/rclone nfsmount wd: /data/orgs/deco/home --option x\n",
            " 101 /App.app/Contents/MacOS/rclone nfsmount wd: /data/orgs/acme/uploads\n",
        );
        assert_eq!(orphaned_rclone_pids(ps, &marker("/data")), vec![100, 101]);
    }

    /// The same matcher against the Linux argv: an AppImage-mounted binary and
    /// the `mount` subcommand instead of `nfsmount`.
    #[test]
    fn finds_orphaned_rclone_servers_from_an_appimage() {
        let ps = concat!(
            " 200 /tmp/.mount_decoAb12/usr/bin/rclone --config",
            " /home/me/.local/share/deco/.decocms/rclone/acme/home.conf mount wd:",
            " /home/me/.local/share/deco/orgs/acme/home --vfs-cache-mode full\n",
        );
        assert_eq!(
            orphaned_rclone_pids(ps, &marker("/home/me/.local/share/deco")),
            vec![200]
        );
    }

    /// This SIGKILLs what it matches, so everything it must NOT match is the
    /// part worth pinning.
    #[test]
    fn never_kills_a_process_that_is_not_ours() {
        let ps = concat!(
            // The user's own rclone, serving their own backup.
            " 102 /usr/local/bin/rclone mount remote: /Users/me/backup\n",
            // Our app itself.
            " 103 /App.app/Contents/MacOS/deco\n",
            // Something merely MENTIONING the path — a grep, an editor. Named
            // WITH the marker's trailing separator, so the path boundary cannot
            // be what spares it and the subcommand conjunct is what must.
            " 104 grep -r rclone /data/orgs/\n",
            // Another app's org mounts, same layout, different root.
            " 105 /Other.app/Contents/MacOS/rclone nfsmount wd: /elsewhere/orgs/deco/home\n",
            // The user's own FUSE mount, in a SIBLING directory whose name
            // merely starts with our marker's characters. Its remote is `wd:`
            // on purpose: only the marker's path boundary may be what spares
            // it, since a user is free to name their own remote whatever we
            // name ours.
            " 106 /usr/bin/rclone mount wd: /data/orgs-backup/wd\n",
            // Another app's Linux org mounts, same layout, different root.
            " 107 /tmp/.mount_otherXy/usr/bin/rclone mount wd: /elsewhere/orgs/deco/home\n",
        );
        assert!(orphaned_rclone_pids(ps, &marker("/data")).is_empty());
    }

    /// The marker is matched as a raw substring against another process's argv,
    /// so only a path boundary separates our `orgs/` from every sibling that
    /// shares its prefix — and this SIGKILLs what it matches.
    #[test]
    fn the_orgs_marker_is_anchored_at_a_path_boundary() {
        assert_eq!(marker("/data"), "/data/orgs/");
        assert_eq!(marker("/data/"), "/data/orgs/");
        for sibling in [
            " 1 /usr/bin/rclone mount wd: /data/orgs-backup/wd\n",
            " 2 /usr/bin/rclone mount wd: /data/orgsomething/wd\n",
        ] {
            assert!(
                orphaned_rclone_pids(sibling, &marker("/data")).is_empty(),
                "{sibling}"
            );
        }
        assert_eq!(
            orphaned_rclone_pids(
                " 3 /usr/bin/rclone mount wd: /data/orgs/acme/home\n",
                &marker("/data")
            ),
            vec![3]
        );
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

    /// Every disagreement between "we own a child" and "the kernel shows a
    /// mount" is a repair, not a skip. Trusting the table alone let a ghost
    /// mount from a dead app generation suppress the respawn, so the volume
    /// stayed broken and writes fell through to the raw directory.
    #[test]
    fn only_an_owned_and_attached_mount_is_kept() {
        assert_eq!(mount_plan(true, true), MountPlan::Keep);
        assert_eq!(mount_plan(false, true), MountPlan::ReclaimGhostThenSpawn);
        assert_eq!(mount_plan(true, false), MountPlan::ReapOwnThenSpawn);
        assert_eq!(mount_plan(false, false), MountPlan::Spawn);
    }

    /// The gate is the ONLY thing keeping a platform without this mount stack
    /// from spawning rclone, and the env var is the escape a user reaches for
    /// when a mount wedges — neither may be conditional on the other. Windows
    /// has no stack (it would need WinFsp), so the platform half may never
    /// widen to unconditional.
    #[test]
    fn org_fs_runs_only_where_it_is_supported_and_not_disabled() {
        assert!(org_fs_enabled_for(true, false));
        assert!(!org_fs_enabled_for(true, true), "the env var always wins");
        assert!(!org_fs_enabled_for(false, false));
        assert!(!org_fs_enabled_for(false, true));

        assert_eq!(
            PLATFORM_SUPPORTED,
            cfg!(any(target_os = "macos", target_os = "linux"))
        );
    }

    /// An absent state means "keep waiting", and a disabled org-fs never
    /// writes one — so answering from the loop would spend `READY_TIMEOUT` on
    /// every single sandbox ensure to reach the same `false`.
    #[tokio::test]
    async fn a_disabled_org_fs_answers_immediately_instead_of_waiting_the_timeout() {
        let started = Instant::now();
        let ready = wait_ready_when(Path::new("/nonexistent"), "disabled-org", false).await;
        let elapsed = started.elapsed();

        assert!(!ready);
        assert!(
            elapsed < READY_TIMEOUT,
            "waited {elapsed:?} for an answer that needs no waiting"
        );
        assert!(
            lock_states().get("disabled-org").is_none(),
            "a disabled org-fs must not touch the claim/settle state machine"
        );
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

    #[test]
    fn sweeps_every_rclone_fuse_mount_under_the_orgs_root() {
        let found = stale_mountpoints_for(true, PROC_TABLE, Path::new("/app"));
        assert_eq!(
            found,
            vec![
                PathBuf::from("/app/orgs/acme/home"),
                PathBuf::from("/app/orgs/acme/uploads"),
                PathBuf::from("/app/orgs/other-org/public"),
            ]
        );
    }

    /// Reading a table in the other platform's dialect must yield NOTHING —
    /// the failure mode of a mis-picked parser is a sweep that does nothing,
    /// never one that force-unmounts a path it misread.
    #[test]
    fn neither_dialect_parses_the_others_table() {
        assert!(stale_mountpoints_for(true, TABLE, Path::new("/app")).is_empty());
        assert!(stale_mountpoints_for(false, PROC_TABLE, Path::new("/app")).is_empty());
    }

    #[test]
    fn reads_a_proc_mounts_entry() {
        assert_eq!(
            parse_proc_mounts_line(
                "wd: /app/orgs/acme/home fuse.rclone rw,nosuid,nodev,relatime,user_id=1000 0 0"
            ),
            Some((
                PathBuf::from("/app/orgs/acme/home"),
                "fuse.rclone".to_string()
            ))
        );
        assert_eq!(
            parse_proc_mounts_line("/dev/sda1 / ext4 rw,relatime 0 0"),
            Some((PathBuf::from("/"), "ext4".to_string()))
        );
    }

    /// `/proc` separates fields with spaces, so a mountpoint containing one
    /// arrives escaped. Taking it raw would truncate the path this sweep then
    /// force-unmounts.
    #[test]
    fn decodes_an_escaped_proc_mountpoint() {
        assert_eq!(
            parse_proc_mounts_line("wd: /app/orgs/my\\040org/home fuse.rclone rw 0 0"),
            Some((
                PathBuf::from("/app/orgs/my org/home"),
                "fuse.rclone".to_string()
            ))
        );
        assert_eq!(
            stale_mountpoints_for(
                true,
                "wd: /app/orgs/my\\040org/home fuse.rclone rw 0 0\n",
                Path::new("/app")
            ),
            vec![PathBuf::from("/app/orgs/my org/home")]
        );
    }

    /// A backslash is itself escaped, so decoding may not re-scan its own
    /// output: `\134040` is the six characters `\040`, not a space.
    #[test]
    fn never_decodes_an_escape_it_produced() {
        assert_eq!(unescape_octal("a\\134040b"), "a\\040b");
        // Not three octal digits, and out of a byte's range: left alone.
        assert_eq!(unescape_octal("a\\08b\\777c"), "a\\08b\\777c");
        assert_eq!(unescape_octal("tab\\011hash\\043end"), "tab\thash#end");
    }

    #[test]
    fn tolerates_proc_lines_that_are_not_mount_entries() {
        for line in [
            "",
            "garbage",
            "wd: /app/orgs/acme/home fuse.rclone rw",
            "localhost:/wd{x} on /app/orgs/acme/home (nfs, nodev)",
        ] {
            assert!(parse_proc_mounts_line(line).is_none(), "{line:?}");
        }
    }

    /// The sweep force-unmounts what this accepts, so a neighbouring FUSE
    /// filesystem — or somebody else's rclone — must not qualify on its type.
    #[test]
    fn only_our_own_filesystem_type_is_swept() {
        assert!(is_org_fstype(true, "fuse.rclone"));
        assert!(!is_org_fstype(true, "fuse.sshfs"));
        assert!(!is_org_fstype(true, "rclonefs"));
        assert!(!is_org_fstype(true, "ext4"));
        assert!(!is_org_fstype(true, "nfs"));

        assert!(is_org_fstype(false, "nfs"));
        assert!(!is_org_fstype(false, "fuse.rclone"));
        assert!(!is_org_fstype(false, "apfs"));
    }

    /// The argv that has been shipping on macOS, pinned token by token: the
    /// Linux port may not perturb one of them.
    #[test]
    fn the_macos_mount_argv_is_unchanged() {
        assert_eq!(
            mount_args(
                false,
                Path::new("/cfg/home.conf"),
                Path::new("/app/orgs/acme/home"),
                "home"
            ),
            [
                "--config",
                "/cfg/home.conf",
                "nfsmount",
                "wd:",
                "/app/orgs/acme/home",
                "--option",
                "actimeo=1,locallocks,soft,timeo=100,retrans=2,nobrowse",
                "--vfs-cache-mode",
                "full",
                "--vfs-write-back",
                "1s",
                "--dir-cache-time",
                "10s",
                "--timeout",
                "5s",
                "--contimeout",
                "3s",
                "--low-level-retries",
                "1",
            ]
            .map(OsString::from)
        );
    }

    /// `--read-only` stays LAST, and macOS gains no `--file-perms` with it.
    #[test]
    fn a_read_only_volume_keeps_the_macos_argv_it_shipped_with() {
        let args = mount_args(
            false,
            Path::new("/cfg/public.conf"),
            Path::new("/app/orgs/acme/public"),
            "public",
        );
        let writable = mount_args(
            false,
            Path::new("/cfg/public.conf"),
            Path::new("/app/orgs/acme/public"),
            "home",
        );
        assert_eq!(args.len(), writable.len() + 1);
        assert_eq!(args[..writable.len()], writable[..]);
        assert_eq!(args.last(), Some(&OsString::from("--read-only")));
    }

    #[test]
    fn the_linux_mount_argv_is_fuse_shaped() {
        let args = mount_args(
            true,
            Path::new("/cfg/home.conf"),
            Path::new("/app/orgs/acme/home"),
            "home",
        );
        assert_eq!(
            args,
            [
                "--config",
                "/cfg/home.conf",
                "mount",
                "wd:",
                "/app/orgs/acme/home",
                "--attr-timeout",
                "1s",
                "--vfs-cache-mode",
                "full",
                "--vfs-write-back",
                "1s",
                "--dir-cache-time",
                "10s",
                "--timeout",
                "5s",
                "--contimeout",
                "3s",
                "--low-level-retries",
                "1",
            ]
            .map(OsString::from)
        );
    }

    /// `--allow-other` would make the mount depend on `user_allow_other` in
    /// the root-owned `/etc/fuse.conf`, without which libfuse refuses to mount
    /// at all — and a desktop mounts and reads as one uid, so it buys nothing.
    #[test]
    fn the_linux_mount_argv_carries_nothing_macos_shaped_or_privileged() {
        let args = mount_args(
            true,
            Path::new("/cfg/home.conf"),
            Path::new("/app/orgs/acme/home"),
            "home",
        );
        let tokens: Vec<&str> = args.iter().filter_map(|arg| arg.to_str()).collect();
        for absent in ["--allow-other", "--option", "nfsmount"] {
            assert!(!tokens.contains(&absent), "{absent}");
        }
    }

    /// The org filesystem carries no mode bits, so a read-only public set's
    /// helper scripts get their execute bit from the mount or not at all.
    #[test]
    fn a_read_only_linux_volume_is_mounted_executable() {
        let args = mount_args(
            true,
            Path::new("/cfg/public.conf"),
            Path::new("/app/orgs/acme/public"),
            "public",
        );
        let tail: Vec<&str> = args
            .iter()
            .rev()
            .take(3)
            .rev()
            .filter_map(|arg| arg.to_str())
            .collect();
        assert_eq!(tail, vec!["--read-only", "--file-perms", "0755"]);
    }

    /// One tail, so a VFS or timeout change can never land on one platform
    /// alone; the heads are the same length by coincidence, not by contract,
    /// which is why this compares from a named boundary.
    #[test]
    fn both_stacks_share_one_argv_tail() {
        let config = Path::new("/cfg/home.conf");
        let mountpoint = Path::new("/app/orgs/acme/home");
        let macos = mount_args(false, config, mountpoint, "home");
        let linux = mount_args(true, config, mountpoint, "home");
        let tail = |args: &[OsString]| args[args.len() - SHARED_MOUNT_ARGS.len()..].to_vec();
        assert_eq!(tail(&macos), tail(&linux));
        assert_eq!(tail(&macos), SHARED_MOUNT_ARGS.map(OsString::from));
    }

    /// Program and flag as shipped; the mountpoint is the one token that now
    /// arrives verbatim rather than lossily spelled (see [`detach_commands`]).
    #[test]
    fn macos_detaches_with_exactly_one_forced_unmount() {
        assert_eq!(
            detach_commands(false, Path::new("/app/orgs/acme/home")),
            vec![["umount", "-f", "/app/orgs/acme/home"]
                .map(OsString::from)
                .to_vec()]
        );
    }

    /// Order is the contract: fuse3's binary first (the name rclone's own mount
    /// helper reaches for), the fuse2-era name second, and privileged `umount`
    /// only as a last resort. All lazy — which bounds the kernel's half of the
    /// detach; [`detach_chain`] bounds the helper's.
    #[test]
    fn linux_detaches_through_the_fuse3_chain_first() {
        let commands = detach_commands(true, Path::new("/app/orgs/acme/home"));
        let shape: Vec<Vec<&str>> = commands
            .iter()
            .map(|command| command.iter().filter_map(|arg| arg.to_str()).collect())
            .collect();
        assert_eq!(
            shape,
            vec![
                vec!["fusermount3", "-uz", "/app/orgs/acme/home"],
                vec!["fusermount", "-uz", "/app/orgs/acme/home"],
                vec!["umount", "-l", "/app/orgs/acme/home"],
            ]
        );
    }

    /// `tauri dev` copies no `externalBin`, so the only rclone there is the one
    /// `scripts/fetch-rclone.sh` downloaded under its host triple — a name this
    /// has to reproduce exactly or the dev loop silently has no org filesystem.
    #[test]
    fn the_dev_rclone_is_looked_up_under_its_host_triple() {
        assert_eq!(
            dev_rclone_name(false, "aarch64"),
            "rclone-aarch64-apple-darwin"
        );
        assert_eq!(
            dev_rclone_name(true, "x86_64"),
            "rclone-x86_64-unknown-linux-gnu"
        );
        // The four `slug_for_triple` in that script has an official build for:
        // this host must be one of them, or nothing was ever downloaded.
        let here = dev_rclone_name(LINUX_MOUNT_STACK, std::env::consts::ARCH);
        assert!(
            [
                "rclone-aarch64-apple-darwin",
                "rclone-x86_64-apple-darwin",
                "rclone-x86_64-unknown-linux-gnu",
                "rclone-aarch64-unknown-linux-gnu",
            ]
            .contains(&here.as_str()),
            "{here}"
        );
    }

    /// A mountpoint that is not valid UTF-8 must reach the unmount verbatim:
    /// lossy replacement would name a path that does not exist, leaving the
    /// real ghost attached. Both stacks, because this is the one macOS argv
    /// that is deliberately not what shipped — see [`detach_commands`].
    #[cfg(unix)]
    #[test]
    fn a_mountpoint_that_is_not_utf8_survives_the_detach_chain() {
        use std::os::unix::ffi::OsStrExt;

        let raw = std::ffi::OsStr::from_bytes(b"/app/orgs/ac\xffme/home");
        for linux in [true, false] {
            for command in detach_commands(linux, Path::new(raw)) {
                assert_eq!(command.last(), Some(&raw.to_os_string()), "linux={linux}");
            }
        }
    }

    /// The program each command in a chain names, in order.
    fn programs_of(commands: &[Vec<OsString>]) -> Vec<String> {
        commands
            .iter()
            .filter_map(|command| Some(command.first()?.to_string_lossy().into_owned()))
            .collect()
    }

    /// libfuse stats the mountpoint before `umount2`, and against a wedged FUSE
    /// server that stat blocks in uninterruptible sleep — so `fusermount3 -uz`
    /// never exits, however lazy the flag is. An unbounded command there stalls
    /// the whole chain, and with it the mount attempt that called it.
    #[tokio::test]
    async fn a_detach_command_that_never_exits_falls_through_to_the_next() {
        let attempted = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = std::sync::Arc::clone(&attempted);
        let reclaimed = detach_chain(
            detach_commands(true, Path::new("/app/orgs/acme/home")),
            Duration::from_millis(20),
            move |command| {
                let seen = std::sync::Arc::clone(&seen);
                async move {
                    let program = command
                        .first()
                        .map(|program| program.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let last = program == "umount";
                    seen.lock().unwrap().push(program);
                    // Only the last one answers; the two before it wedge.
                    if last {
                        true
                    } else {
                        std::future::pending::<bool>().await
                    }
                }
            },
        )
        .await;

        assert!(reclaimed, "the chain must reach a command that can answer");
        assert_eq!(
            *attempted.lock().unwrap(),
            programs_of(&detach_commands(true, Path::new("/app/orgs/acme/home"))),
            "an elapsed command is a failed one: try the next"
        );
    }

    /// And when nothing answers, the chain still ends. Unbounded, this was the
    /// call that left an org `InFlight` for the rest of the process's life.
    #[tokio::test]
    async fn a_wholly_wedged_detach_chain_still_gives_up() {
        assert!(
            !detach_chain(
                detach_commands(true, Path::new("/app/orgs/acme/home")),
                Duration::from_millis(20),
                |_| std::future::pending::<bool>(),
            )
            .await
        );
    }

    /// `create_dir_all` on a wedged mountpoint blocks the same way the unmount
    /// does, so bounding the commands alone leaves the attempt itself
    /// unbounded — and `InFlight` is the state machine's absorbing state:
    /// `claim` refuses every later attempt, so only a restart recovers.
    #[tokio::test]
    async fn a_mount_attempt_that_never_returns_still_settles_the_org() {
        lock_states().remove("wedged-org");
        clear_abandoned("wedged-org");
        assert!(claim("wedged-org").is_some());

        let outcome =
            attempt_mount(Duration::from_millis(20), std::future::pending::<bool>()).await;
        settle_attempt("wedged-org", outcome);
        assert_eq!(
            outcome,
            Attempt::Abandoned,
            "an attempt that never answered did not succeed"
        );

        // Failed, not InFlight: refused now, but retried once the cooldown
        // lapses — which is the difference a restart used to be needed for.
        assert!(claim("wedged-org").is_none(), "still cooling off");
        lock_states().insert(
            "wedged-org".to_string(),
            MountState::Failed {
                until: Instant::now() - Duration::from_secs(1),
            },
        );
        assert!(claim("wedged-org").is_some(), "retried after the cooldown");
        lock_states().remove("wedged-org");
        clear_abandoned("wedged-org");

        // A bounded attempt that DOES answer is passed through untouched, and
        // its two answers stay distinguishable from the hang.
        assert_eq!(
            attempt_mount(MOUNT_ATTEMPT_TIMEOUT, std::future::ready(true)).await,
            Attempt::Mounted
        );
        assert_eq!(
            attempt_mount(MOUNT_ATTEMPT_TIMEOUT, std::future::ready(false)).await,
            Attempt::Failed
        );
    }

    /// How long `org_slug` is currently being left alone for.
    fn cooldown_of(org_slug: &str) -> Duration {
        match lock_states().get(org_slug).copied() {
            Some(MountState::Failed { until }) => until.saturating_duration_since(Instant::now()),
            other => panic!("expected {org_slug} to have failed, found {other:?}"),
        }
    }

    /// An abandoned attempt has parked a `spawn_blocking` thread that never
    /// comes back, and `warm` runs on every org-scoped request — so retrying a
    /// wedged org at a fixed cooldown strands one more thread per cycle,
    /// indefinitely, out of the 512 this whole process shares. Growth is what
    /// bounds that. A completed failure strands nothing and must not pay for it.
    #[test]
    fn only_an_abandoned_attempt_makes_the_next_retry_wait_longer() {
        let org = "backoff-org";
        lock_states().remove(org);
        clear_abandoned(org);

        settle_attempt(org, Attempt::Abandoned);
        let first = cooldown_of(org);
        settle_attempt(org, Attempt::Abandoned);
        settle_attempt(org, Attempt::Abandoned);
        let third = cooldown_of(org);

        assert!(first <= FAILURE_COOLDOWN, "first wait was {first:?}");
        assert!(
            third > FAILURE_COOLDOWN,
            "a third abandoned attempt still waited only {third:?}"
        );
        assert!(third <= ABANDONED_COOLDOWN_CAP, "third wait was {third:?}");

        settle_attempt(org, Attempt::Failed);
        let flat = cooldown_of(org);
        assert!(
            flat <= FAILURE_COOLDOWN && flat + Duration::from_secs(1) >= FAILURE_COOLDOWN,
            "a failure that stranded nothing kept {flat:?}, not the flat cooldown"
        );

        settle_attempt(org, Attempt::Mounted);
        assert_eq!(lock_states().get(org).copied(), Some(MountState::Ready));
        settle_attempt(org, Attempt::Abandoned);
        assert!(
            cooldown_of(org) <= FAILURE_COOLDOWN,
            "a mount that attached must start the backoff over"
        );

        lock_states().remove(org);
        clear_abandoned(org);
    }

    /// The backoff itself, which the leak bound rests on: it grows, it stops at
    /// the cap, and every draw lands inside the jitter window.
    #[test]
    fn the_backoff_grows_monotonically_and_never_exceeds_its_cap() {
        let cap = Duration::from_secs(3600);
        let base = Duration::from_secs(30);
        let undiluted =
            |attempt| exponential_backoff_with_jitter(cap, base, attempt, 2.0, 0.5, 0.0);

        assert_eq!(undiluted(0), base);
        assert_eq!(undiluted(1), Duration::from_secs(60));
        assert_eq!(undiluted(2), Duration::from_secs(120));

        let mut previous = Duration::ZERO;
        for attempt in 0..64u32 {
            let exp = undiluted(attempt);
            assert!(
                exp >= previous,
                "attempt {attempt}: {exp:?} after {previous:?}"
            );
            assert!(exp <= cap, "attempt {attempt}: {exp:?} is over the cap");
            for sample in [0.0, 0.25, 0.5, 0.75, 1.0] {
                let delay = exponential_backoff_with_jitter(cap, base, attempt, 2.0, 0.5, sample);
                assert!(
                    delay <= exp && delay >= exp / 2,
                    "attempt {attempt} sample {sample}: {delay:?} outside [{:?}, {exp:?}]",
                    exp / 2
                );
            }
            previous = exp;
        }

        // An attempt count no arithmetic can hold is the cap, never a wrap into
        // a short wait.
        assert_eq!(undiluted(u32::MAX), cap);
        // The ends of the jitter range: none shortens nothing, full may shorten
        // everything.
        assert_eq!(
            exponential_backoff_with_jitter(cap, base, 3, 2.0, 0.0, 1.0),
            Duration::from_secs(240)
        );
        assert_eq!(
            exponential_backoff_with_jitter(cap, base, 3, 2.0, 1.0, 1.0),
            Duration::ZERO
        );
        // A draw that is not a number waits longer; it may not panic the mount
        // task, and it may not wait less.
        assert_eq!(
            exponential_backoff_with_jitter(cap, base, 3, 2.0, 0.5, f64::NAN),
            cap
        );
    }

    /// The step sizes the org mounts actually use: today's cooldown first, then
    /// doubling to an hour — eight abandoned attempts, and so eight stranded
    /// threads, before the cap takes over.
    #[test]
    fn the_abandoned_cooldown_starts_where_the_flat_one_did_and_reaches_the_cap() {
        assert_eq!(abandoned_cooldown(1, 0.0), FAILURE_COOLDOWN);
        assert_eq!(abandoned_cooldown(2, 0.0), FAILURE_COOLDOWN * 2);
        assert_eq!(abandoned_cooldown(0, 0.0), FAILURE_COOLDOWN, "no underflow");
        assert_eq!(abandoned_cooldown(8, 0.0), ABANDONED_COOLDOWN_CAP);
        assert!(abandoned_cooldown(7, 0.0) < ABANDONED_COOLDOWN_CAP);
        for nth in 0..ABANDONED_ATTEMPT_CEILING {
            let cooldown = abandoned_cooldown(nth, rand::random::<f64>());
            assert!(cooldown <= ABANDONED_COOLDOWN_CAP, "{nth}: {cooldown:?}");
            assert!(
                cooldown >= FAILURE_COOLDOWN / 2,
                "{nth}: {cooldown:?} is shorter than the shortest first wait"
            );
        }
    }

    /// Backing off alone leaves the leak linear — slower, but the pool is
    /// finite and shared, so an org left wedged still exhausts it, just days
    /// later instead of hours. Past the ceiling the org is not tried again at
    /// all, which is what makes the stranded threads a fixed cost. It used to
    /// stay at the cap forever, so this inverts that expectation.
    #[test]
    fn a_wedged_org_stops_being_retried_once_the_ceiling_is_reached() {
        assert!(
            abandoned_cooldown(ABANDONED_ATTEMPT_CEILING - 1, 0.0) <= ABANDONED_COOLDOWN_CAP,
            "the last retried attempt still waits a bounded time"
        );
        for nth in [
            ABANDONED_ATTEMPT_CEILING,
            ABANDONED_ATTEMPT_CEILING + 1,
            u32::MAX,
        ] {
            assert_eq!(
                abandoned_cooldown(nth, rand::random::<f64>()),
                WEDGED_COOLDOWN,
                "{nth} should no longer be retried"
            );
        }
        assert!(
            WEDGED_COOLDOWN > ABANDONED_COOLDOWN_CAP * 24 * 30,
            "the wedged cooldown has to outlast any real session"
        );
    }

    /// Attachment is a question about a PATH — the path is already ours. Gating
    /// it on the filesystem type too made a type this module does not recognise
    /// (a libfuse build that drops `subtype=`, a different backend, a path the
    /// lossily-decoded table no longer spells the same way) read as unattached,
    /// so the next cycle killed a WORKING rclone and every cycle after it
    /// repeated that. The sweep keeps the narrow predicate, where a miss only
    /// means a mount is left alone.
    #[test]
    fn attachment_is_detected_whatever_filesystem_type_the_table_reports() {
        let table = concat!(
            "wd: /app/orgs/acme/home fuse rw,nosuid,nodev 0 0\n",
            "wd: /app/orgs/acme/uploads fuse.rclone rw,nosuid,nodev 0 0\n",
        );
        let attached = table_mountpoints(true, table);
        let unrecognised = PathBuf::from("/app/orgs/acme/home");
        assert!(attached.contains(&unrecognised));
        assert_eq!(
            mount_plan(true, attached.contains(&unrecognised)),
            MountPlan::Keep,
            "a live mount of ours is kept, not killed and respawned"
        );
        assert_eq!(
            stale_mountpoints_for(true, table, Path::new("/app")),
            vec![PathBuf::from("/app/orgs/acme/uploads")],
            "the force-unmount sweep stays scoped to the type it knows"
        );

        // The same split in the macOS dialect.
        let bsd = "localhost:/wd{x} on /app/orgs/acme/home (macfuse, nodev)\n";
        assert!(table_mountpoints(false, bsd).contains(&unrecognised));
        assert!(stale_mountpoints_for(false, bsd, Path::new("/app")).is_empty());
    }

    /// A subtype mismatch is otherwise indistinguishable from a mount that
    /// never happened, and the two need opposite repairs — so the one warning
    /// line a failed attach leaves behind has to carry the type actually found.
    #[test]
    fn the_filesystem_type_at_a_mountpoint_is_reportable() {
        assert_eq!(
            fstype_at(true, PROC_TABLE, Path::new("/app/orgs/acme/home")),
            Some("fuse.rclone".to_string())
        );
        assert_eq!(
            fstype_at(false, TABLE, Path::new("/app/orgs/acme/home")),
            Some("nfs".to_string())
        );
        assert_eq!(
            fstype_at(true, PROC_TABLE, Path::new("/app/orgs/acme/never-mounted")),
            None
        );
    }

    /// The boot sweep is the half that force-unmounts and SIGKILLs, so the
    /// runtime escape a user reaches for when THAT is what went wrong has to
    /// stop it too — it now rides `org_fs_enabled()` rather than the platform
    /// alone, which is a deliberate macOS behavior change: `DECOCMS_DISABLE_ORG_FS=1`
    /// used to still reclaim ghosts at boot and no longer does.
    ///
    /// `Skipped` is reachable only from the gate, ahead of the mount table read
    /// and of every process this would otherwise spawn.
    #[tokio::test]
    async fn a_disabled_org_fs_sweeps_nothing_at_boot() {
        assert_eq!(
            prune_stale_mounts_when(Path::new("/nonexistent"), false).await,
            Sweep::Skipped
        );
    }
}
