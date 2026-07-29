//! The ONE home for the parent-liveness watchdog and its anchored
//! process-group machinery, shared by this crate's plain-pipe spawn path
//! and `local-api`'s `ProcessGroupChild`.
//!
//! Why this module exists: both crates anchor every spawned workload to an
//! independent `/bin/sh` watchdog that (a) pins the PGID until the group is
//! proven empty, (b) owns the shared child-lifetime lock as an exec-inherited
//! descriptor, and (c) TERM→KILLs survivors when the parent's liveness pipe
//! hits EOF. The shell script encoding those guarantees and the
//! enumerate-then-signal helper that must never touch the anchor used to be
//! duplicated per crate — a one-sided edit to either copy would silently skew
//! crash-recovery semantics between harness CLI runs and local-api tasks.
//! Keeping one copy here (the crate both consumers already depend on) closes
//! that drift channel; only the argv0 label differs per caller so `ps` output
//! still attributes each anchor to its family.
//!
//! Script contract (pinned by this module's tests):
//! - ignores TERM itself, so graceful TERM reaches the workload while the
//!   ownership anchor survives for a later KILL/reap;
//! - blocks on its stdin liveness pipe; EOF starts TERM rounds, then KILL
//!   rounds, against every non-anchor group member;
//! - exits 0 only once `pgrep` proves no non-anchor member remains — which is
//!   also when its inherited shared lifetime lock is finally released;
//! - an enumeration error parks it forever: an indeterminate cleanup fails
//!   closed rather than unblocking durable recovery.
//!
//! macOS note: `pgrep` excludes its own ancestors, so from inside the
//! watchdog `pgrep -g $$ .` enumerates only the sibling workload and its
//! descendants, never the anchor. The explicit `.` pattern is required by BSD
//! `pgrep`.

use crate::spawn::Signal;

#[cfg(unix)]
const PARENT_LIVENESS_WATCHDOG: &str = r#"
trap '' TERM
while IFS= read -r _; do :; done

term_round=0
while [ "$term_round" -lt 20 ]; do
  members="$(pgrep -g "$$" . 2>/dev/null)"
  status=$?
  if [ "$status" -eq 1 ]; then
    exit 0
  fi
  if [ "$status" -ne 0 ]; then
    while :; do sleep 60; done
  fi
  found=0
  for pid in $members; do
    if [ "$pid" -eq "$$" ]; then continue; fi
    found=1
    kill -TERM "$pid" 2>/dev/null || true
  done
  if [ "$found" -eq 0 ]; then exit 0; fi
  term_round=$((term_round + 1))
  sleep 0.05
done

while :; do
  members="$(pgrep -g "$$" . 2>/dev/null)"
  status=$?
  if [ "$status" -eq 1 ]; then
    exit 0
  fi
  if [ "$status" -ne 0 ]; then
    while :; do sleep 60; done
  fi
  found=0
  for pid in $members; do
    if [ "$pid" -eq "$$" ]; then continue; fi
    found=1
    kill -KILL "$pid" 2>/dev/null || true
  done
  if [ "$found" -eq 0 ]; then exit 0; fi
  sleep 0.05
done
"#;

/// A freshly spawned group anchor: the watchdog child (the process-group
/// leader — its pid IS the group id), the liveness-pipe writer whose drop/EOF
/// triggers the escalating teardown, and the group id workloads must join via
/// `process_group(group_id)`.
#[cfg(unix)]
pub struct SpawnedAnchor {
    pub child: tokio::process::Child,
    pub parent_liveness: tokio::process::ChildStdin,
    pub group_id: u32,
}

/// Opens the shared child-lifetime lock file (creating it `0o600`) and takes
/// a shared advisory lock. The caller hands the locked `File` to
/// [`spawn_anchor`], making the anchor its sole owner as an exec-inherited
/// stdout descriptor — a replacement server taking an exclusive lock is then
/// provably serialized behind every old anchor's group reap.
#[cfg(unix)]
pub fn open_shared_lifetime_lock(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).mode(0o600);
    let file = options.open(path)?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    file.try_lock_shared().map_err(|error| match error {
        std::fs::TryLockError::Error(error) => error,
        std::fs::TryLockError::WouldBlock => std::io::ErrorKind::WouldBlock.into(),
    })?;
    Ok(file)
}

/// Spawns the watchdog as an independent process-group leader. `argv0` labels
/// the anchor in `ps` output so each consuming family stays attributable
/// (e.g. `decocms-harness-watchdog` vs `decocms-local-api-watchdog`).
/// `kill_on_drop` is intentionally false: on abrupt runtime death the
/// liveness pipe, not Tokio's child drop path, lets the watchdog reap the
/// whole group.
#[cfg(unix)]
pub fn spawn_anchor(
    argv0: &str,
    lifetime_lock: Option<std::fs::File>,
) -> std::io::Result<SpawnedAnchor> {
    use std::process::Stdio;

    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(PARENT_LIVENESS_WATCHDOG)
        .arg(argv0)
        .stdin(Stdio::piped())
        // The locked File (when given) moves into an exec-open descriptor;
        // the anchor is now the fence's sole owner, including after the
        // parent is SIGKILLed.
        .stdout(lifetime_lock.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(false);
    let mut child = command.spawn()?;
    let group_id = child
        .id()
        .ok_or_else(|| std::io::Error::other("group-anchor watchdog reported no pid"))?;
    let parent_liveness = child
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("group-anchor watchdog stdin was not piped"))?;
    Ok(SpawnedAnchor {
        child,
        parent_liveness,
        group_id,
    })
}

/// Signals every current member of the anchored group except the anchor
/// itself. `kill -SIG -<pgid>` is deliberately forbidden here: it would hit
/// the watchdog (the group leader), close its inherited shared lifetime-lock
/// descriptor, and release the restart fence before resistant descendants
/// were proven gone. Enumeration is immediate and never persisted; the
/// still-live anchor keeps the group id owned, so a stale caller cannot
/// later target a recycled process group.
///
/// Returns `true` when every enumerated member was signaled (or the group was
/// already empty — `pgrep` exit 1). Any indeterminate enumeration sends
/// nothing and returns `false`, leaving the watchdog's EOF path to fail
/// closed. Blocking: callers on an async runtime wrap this in
/// `spawn_blocking`.
#[cfg(unix)]
pub fn signal_non_anchor_members(group_id: u32, anchor_id: u32, signal: Signal) -> bool {
    use std::process::Stdio;

    let output = match std::process::Command::new("pgrep")
        .args(["-g", &group_id.to_string(), "."])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            tracing::error!(%error, group_id, "cannot enumerate anchored process group");
            return false;
        }
    };
    if !output.status.success() {
        // `pgrep` exits 1 when it matched nothing: a valid empty-group
        // observation. All other nonzero statuses are indeterminate.
        if output.status.code() != Some(1) {
            tracing::error!(
                status = ?output.status.code(),
                group_id,
                "indeterminate anchored process-group enumeration"
            );
        }
        return output.status.code() == Some(1);
    }

    let mut all_signaled = true;
    for pid in String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|raw| raw.parse::<u32>().ok())
        .filter(|pid| *pid != anchor_id)
    {
        let signaled = std::process::Command::new("kill")
            .arg(signal.flag())
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        all_signaled &= signaled;
    }
    all_signaled
}

/// The anchored watchdog exists only on Unix. Kept as a compile-time
/// counterpart because async callers branch on an `Option` anchor id that is
/// always `None` off-Unix.
#[cfg(not(unix))]
pub fn signal_non_anchor_members(_group_id: u32, _anchor_id: u32, _signal: Signal) -> bool {
    false
}

#[cfg(all(test, unix))]
mod tests {
    use std::time::Duration;

    use super::*;

    /// Pins the script's core contract: the anchor holds the shared lifetime
    /// fence while alive, ignores TERM, and after liveness-pipe EOF exits 0
    /// (releasing the fence) only once its group has no non-anchor member.
    #[tokio::test]
    async fn anchor_holds_the_fence_and_exits_only_after_liveness_eof() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("child-lifetime.lock");
        let lock = open_shared_lifetime_lock(&lock_path).expect("open shared fence");
        let SpawnedAnchor {
            mut child,
            parent_liveness,
            group_id,
        } = spawn_anchor("decocms-watchdog-pin-test", Some(lock)).expect("spawn anchor");

        let contender = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .expect("open fence contender");
        assert!(
            matches!(contender.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
            "a live anchor must hold the shared lifetime fence"
        );

        // TERM is ignored: the anchor must survive to perform escalation.
        // Give the freshly spawned `/bin/sh` time to reach its `trap ''
        // TERM` line first — the guarantee starts once the script runs, and
        // TERMing the pid before that would only race shell startup.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let termed = std::process::Command::new("kill")
            .args(["-TERM", &group_id.to_string()])
            .status()
            .is_ok_and(|status| status.success());
        assert!(termed, "TERM the anchor");
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(
            child.try_wait().expect("try_wait anchor").is_none(),
            "the anchor must ignore TERM"
        );

        // EOF with an otherwise-empty group: exit 0 and release the fence.
        drop(parent_liveness);
        let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("anchor exited after liveness EOF")
            .expect("anchor wait succeeded");
        assert!(status.success());
        contender
            .try_lock()
            .expect("fence becomes claimable only after the anchor exits");
    }

    /// Pins the enumerate-then-signal helper: it reaps a workload joined to
    /// the anchored group but never signals the anchor itself.
    #[tokio::test]
    async fn signal_non_anchor_members_spares_the_anchor() {
        let SpawnedAnchor {
            mut child,
            parent_liveness,
            group_id,
        } = spawn_anchor("decocms-watchdog-signal-test", None).expect("spawn anchor");

        let mut workload_cmd = tokio::process::Command::new("sleep");
        workload_cmd
            .arg("30")
            .process_group(i32::try_from(group_id).expect("group id fits i32"))
            .kill_on_drop(true);
        let mut workload = workload_cmd.spawn().expect("join workload to the group");

        let group_id_for_signal = group_id;
        let all_signaled = tokio::task::spawn_blocking(move || {
            signal_non_anchor_members(group_id_for_signal, group_id_for_signal, Signal::Kill)
        })
        .await
        .expect("signal task completed");
        assert!(all_signaled, "the workload must be signaled");

        let status = tokio::time::timeout(Duration::from_secs(5), workload.wait())
            .await
            .expect("workload reaped after group signal")
            .expect("workload wait succeeded");
        assert!(!status.success(), "the workload died to the signal");
        assert!(
            child.try_wait().expect("try_wait anchor").is_none(),
            "the anchor must never be signaled with its group"
        );

        drop(parent_liveness);
        let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
    }
}
