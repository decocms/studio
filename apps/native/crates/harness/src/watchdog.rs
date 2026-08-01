//! The ONE home for parent-liveness watchdogs, shared by the plain-pipe
//! process-group spawn path and interactive controlling-terminal sessions.
//!
//! Plain-pipe workloads share the watcher's process group. PTY workloads have
//! foreground job-control groups, so their watcher instead records the
//! controlling terminal and enumerates every process attached to that tty.
//! Both watchers own the shared child-lifetime lock as an exec-inherited
//! descriptor and release it only after their target is proven empty.
//!
//! Plain-pipe script contract (pinned by this module's tests):
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
//!
//! PTY startup uses a watcher-first admission protocol. The PTY wrapper
//! atomically publishes its pid and tty, checks its actual PPID while waiting,
//! and cannot exec the requested CLI until the owner atomically publishes
//! `GO`. `portable-pty` closes every descriptor above stderr in its forked
//! child, so a pipe cannot make fork and registration one atomic operation. A
//! wrapper starved before registration may therefore overlap a replacement
//! process after the watcher's bounded wait, but it remains inert: the absent
//! gate and independent PPID check ensure it can only exit, never start the
//! CLI outside the old watcher's fence.

use crate::spawn::Signal;

#[cfg(unix)]
const SESSION_REAPER: &str = r#"
reap_terminal() {
  spared_pid="$1"
  terminal_name="$2"
  term_round=0
  while [ "$term_round" -lt 20 ]; do
    members="$(/bin/ps -t "$terminal_name" -o pid= 2>/dev/null)"
    status=$?
    if [ "$status" -eq 1 ]; then return 0; fi
    if [ "$status" -ne 0 ]; then
      while :; do /bin/sleep 60; done
    fi
    found=0
    for pid in $members; do
      if [ -n "$spared_pid" ] && [ "$pid" -eq "$spared_pid" ]; then continue; fi
      /bin/kill -0 "$pid" 2>/dev/null || continue
      found=1
      /bin/kill -TERM "$pid" 2>/dev/null || true
    done
    if [ "$found" -eq 0 ]; then return 0; fi
    term_round=$((term_round + 1))
    /bin/sleep 0.05
  done

  while :; do
    members="$(/bin/ps -t "$terminal_name" -o pid= 2>/dev/null)"
    status=$?
    if [ "$status" -eq 1 ]; then return 0; fi
    if [ "$status" -ne 0 ]; then
      while :; do /bin/sleep 60; done
    fi
    found=0
    for pid in $members; do
      if [ -n "$spared_pid" ] && [ "$pid" -eq "$spared_pid" ]; then continue; fi
      /bin/kill -0 "$pid" 2>/dev/null || continue
      found=1
      /bin/kill -KILL "$pid" 2>/dev/null || true
    done
    if [ "$found" -eq 0 ]; then return 0; fi
    /bin/sleep 0.05
  done
}
"#;

#[cfg(unix)]
fn pty_session_anchor_script() -> String {
    format!(
        r#"{SESSION_REAPER}
# Caught (not ignored) dispositions keep the session-leader wrapper alive and
# reset to defaults in the foreground child, so the real CLI still receives
# Ctrl-C/TERM normally.
trap ':' HUP INT TERM
expected_parent="$1"
target="$2"
gate="$3"
registration_pause="$4"
shift 4

parent_is_live() {{
  actual_parent="$(
    set -- $(/bin/ps -o ppid= -p "$$" 2>/dev/null) || exit 1
    [ "$#" -eq 1 ] || exit 1
    printf '%s' "$1"
  )" || return 1
  [ "$actual_parent" = "$expected_parent" ] &&
    /bin/kill -0 "$expected_parent" 2>/dev/null
}}

# Tests can hold the inert wrapper before registration. Production passes an
# empty path, so this branch is skipped without touching the workspace.
while [ -n "$registration_pause" ] && [ ! -e "$registration_pause" ]; do
  parent_is_live || exit 125
  /bin/sleep 0.02
done

parent_is_live || exit 125
umask 077
terminal_name="$(
  set -- $(/bin/ps -o tty= -p "$$" 2>/dev/null) || exit 1
  [ "$#" -eq 1 ] || exit 1
  printf '%s' "$1"
)" || exit 125
case "$terminal_name" in
  ''|'??'|*[!A-Za-z0-9/_.-]*) exit 125 ;;
esac
registration_next="${{target}}.next"
if ! printf '%s %s\n' "$$" "$terminal_name" > "$registration_next"; then exit 125; fi
if ! /bin/mv -f -- "$registration_next" "$target"; then exit 125; fi

while [ ! -s "$gate" ]; do
  parent_is_live || exit 125
  /bin/sleep 0.02
done
if ! IFS= read -r start < "$gate"; then exit 125; fi
if [ "$start" != "GO" ]; then exit 125; fi

# Keep this registered shell as the session leader until the foreground CLI
# and every process it left on the tty are gone. If the shell exec'd the CLI,
# macOS would detach surviving descendants from the tty as soon as that direct
# process exited, making them undiscoverable (`tty=??`, `sess=0`).
"$@"
workload_status=$?
reap_terminal "$$" "$terminal_name"
exit "$workload_status"
"#
    )
}

#[cfg(unix)]
fn pty_session_watchdog_script() -> String {
    format!(
        r#"{SESSION_REAPER}
target="$1"
gate="$2"
control_dir="$3"

cleanup_control() {{
  /bin/rm -f -- "$target" "${{target}}.next" "$gate" "${{gate}}.next"
  /bin/rmdir -- "$control_dir" 2>/dev/null || true
}}

trap '' HUP INT TERM
aborted=0
while IFS= read -r command; do
  if [ "$command" = "ABORT" ]; then
    aborted=1
    break
  fi
done
if [ "$aborted" -eq 1 ]; then
  cleanup_control
  exit 0
fi

# portable-pty deliberately closes every fd >=3 before exec, so its fork
# cannot inherit an atomic registration pipe. Wait long enough for an already
# forked wrapper to publish its pid and tty. If it was starved beyond this bound, the
# wrapper's independent PPID check still makes it exit inert; it cannot pass
# the absent GO gate or start the requested workload.
registration_round=0
while [ ! -s "$target" ] && [ "$registration_round" -lt 100 ]; do
  registration_round=$((registration_round + 1))
  /bin/sleep 0.02
done

if [ ! -s "$target" ]; then
  cleanup_control
  exit 0
fi
if ! IFS=' ' read -r terminal_owner_pid terminal_name < "$target"; then
  cleanup_control
  exit 0
fi
case "$terminal_owner_pid" in
  ''|*[!0-9]*) cleanup_control; exit 0 ;;
esac
if [ "$terminal_owner_pid" -le 1 ]; then
  cleanup_control
  exit 0
fi
case "$terminal_name" in
  ''|'??'|*[!A-Za-z0-9/_.-]*) cleanup_control; exit 0 ;;
esac

# Preserve the controlling-terminal owner while every CLI/tool process is
# reaped. Only then terminate that final owner and prove the tty empty.
reap_terminal "$terminal_owner_pid" "$terminal_name"
/bin/kill -TERM "$terminal_owner_pid" 2>/dev/null || true
reap_terminal "" "$terminal_name"
cleanup_control
exit 0
"#
    )
}

#[cfg(unix)]
const PARENT_LIVENESS_WATCHDOG: &str = r#"
trap '' TERM
while IFS= read -r _; do :; done

term_round=0
while [ "$term_round" -lt 20 ]; do
  members="$(/usr/bin/pgrep -g "$$" . 2>/dev/null)"
  status=$?
  if [ "$status" -eq 1 ]; then
    exit 0
  fi
  if [ "$status" -ne 0 ]; then
    while :; do /bin/sleep 60; done
  fi
  found=0
  for pid in $members; do
    if [ "$pid" -eq "$$" ]; then continue; fi
    found=1
    /bin/kill -TERM "$pid" 2>/dev/null || true
  done
  if [ "$found" -eq 0 ]; then exit 0; fi
  term_round=$((term_round + 1))
  /bin/sleep 0.05
done

while :; do
  members="$(/usr/bin/pgrep -g "$$" . 2>/dev/null)"
  status=$?
  if [ "$status" -eq 1 ]; then
    exit 0
  fi
  if [ "$status" -ne 0 ]; then
    while :; do /bin/sleep 60; done
  fi
  found=0
  for pid in $members; do
    if [ "$pid" -eq "$$" ]; then continue; fi
    found=1
    /bin/kill -KILL "$pid" 2>/dev/null || true
  done
  if [ "$found" -eq 0 ]; then exit 0; fi
  /bin/sleep 0.05
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

/// Private control directory for one PTY-session watchdog.
///
/// The watchdog is spawned first and owns the shared child-lifetime fence.
/// The subsequently spawned PTY wrapper atomically publishes its pid and tty,
/// then remains inert until [`Self::release`] atomically publishes `GO`.
/// `Drop` removes an unowned directory; after a successful watchdog spawn the
/// independent watcher owns cleanup so it can finish after a SIGKILLed parent.
#[cfg(unix)]
pub struct PtySessionControl {
    directory: std::path::PathBuf,
    target_path: std::path::PathBuf,
    gate_path: std::path::PathBuf,
    watchdog_owns_cleanup: bool,
}

#[cfg(unix)]
impl PtySessionControl {
    pub fn create(directory: std::path::PathBuf) -> std::io::Result<Self> {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

        let mut builder = std::fs::DirBuilder::new();
        builder.mode(0o700).create(&directory)?;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            target_path: directory.join("session-id"),
            gate_path: directory.join("start"),
            directory,
            watchdog_owns_cleanup: false,
        })
    }

    /// Builds the PTY session-leader wrapper. It continuously proves its
    /// actual parent is still `owner_pid` until `GO`; therefore a wrapper
    /// forked just as Studio crashes can only exit inert, never launch the
    /// requested program outside the watcher's fence.
    pub fn command(
        &self,
        owner_pid: u32,
        program: &std::ffi::OsStr,
        args: &[std::ffi::OsString],
    ) -> portable_pty::CommandBuilder {
        self.command_with_registration_pause(owner_pid, program, args, None)
    }

    fn command_with_registration_pause(
        &self,
        owner_pid: u32,
        program: &std::ffi::OsStr,
        args: &[std::ffi::OsString],
        registration_pause: Option<&std::path::Path>,
    ) -> portable_pty::CommandBuilder {
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg(pty_session_anchor_script());
        command.arg("decocms-terminal-session-anchor");
        command.arg(owner_pid.to_string());
        command.arg(&self.target_path);
        command.arg(&self.gate_path);
        command.arg(registration_pause.unwrap_or_else(|| std::path::Path::new("")));
        command.arg(program);
        command.args(args);
        command
    }

    /// Reads the atomically published controlling-terminal owner pid.
    pub fn registered_terminal_owner_pid(&self) -> std::io::Result<Option<u32>> {
        let contents = match std::fs::read_to_string(&self.target_path) {
            Ok(contents) => contents,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut fields = contents.split_whitespace();
        let Some(raw_owner_pid) = fields.next() else {
            return Ok(None);
        };
        let terminal_name = fields.next().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "PTY wrapper registration omitted its terminal",
            )
        })?;
        if fields.next().is_some()
            || terminal_name == "??"
            || !terminal_name.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '.' | '-')
            })
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "PTY wrapper published an invalid terminal",
            ));
        }
        let owner_pid = raw_owner_pid.parse::<u32>().map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "PTY wrapper published an invalid owner pid",
            )
        })?;
        if owner_pid <= 1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "PTY wrapper published a system owner pid",
            ));
        }
        Ok(Some(owner_pid))
    }

    /// Atomically admits the real workload. Callers must first prove the
    /// watcher is alive and the published session id matches the PTY child.
    pub fn release(&self) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;

        let next_path = self.gate_path.with_extension("next");
        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true).mode(0o600);
            let mut file = options.open(&next_path)?;
            file.write_all(b"GO\n")?;
            file.sync_all()?;
            std::fs::rename(&next_path, &self.gate_path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&next_path);
        }
        result
    }

    fn transfer_cleanup_to_watchdog(&mut self) {
        self.watchdog_owns_cleanup = true;
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_file(&self.target_path);
        let _ = std::fs::remove_file(self.target_path.with_extension("next"));
        let _ = std::fs::remove_file(&self.gate_path);
        let _ = std::fs::remove_file(self.gate_path.with_extension("next"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}

#[cfg(unix)]
impl Drop for PtySessionControl {
    fn drop(&mut self) {
        if !self.watchdog_owns_cleanup {
            self.cleanup();
        }
    }
}

/// Independent owner-death watcher for one controlling-terminal session.
/// It owns the optional shared lifetime lock before the PTY wrapper exists.
/// On parent EOF it waits a bounded registration interval, then TERM→KILLs
/// every process on the published tty and releases the fence only after
/// `/bin/ps -t` proves that terminal empty.
#[cfg(unix)]
pub struct SpawnedSessionWatchdog {
    child: std::process::Child,
    parent_liveness: Option<std::process::ChildStdin>,
    control_directory: std::path::PathBuf,
    target_path: std::path::PathBuf,
    gate_path: std::path::PathBuf,
}

#[cfg(unix)]
pub fn spawn_session_watchdog(
    argv0: &str,
    control: &mut PtySessionControl,
    lifetime_lock: Option<std::fs::File>,
) -> std::io::Result<SpawnedSessionWatchdog> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;

    let mut command = std::process::Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(pty_session_watchdog_script())
        .arg(argv0)
        .arg(&control.target_path)
        .arg(&control.gate_path)
        .arg(&control.directory)
        .stdin(Stdio::piped())
        .stdout(lifetime_lock.map(Stdio::from).unwrap_or_else(Stdio::null))
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn()?;
    let Some(parent_liveness) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(std::io::Error::other("PTY watchdog stdin was not piped"));
    };
    control.transfer_cleanup_to_watchdog();
    Ok(SpawnedSessionWatchdog {
        child,
        parent_liveness: Some(parent_liveness),
        control_directory: control.directory.clone(),
        target_path: control.target_path.clone(),
        gate_path: control.gate_path.clone(),
    })
}

#[cfg(unix)]
impl SpawnedSessionWatchdog {
    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
    }

    pub fn trigger_cleanup(&mut self) {
        drop(self.parent_liveness.take());
    }

    pub fn abort(&mut self) -> std::io::Result<std::process::ExitStatus> {
        use std::io::Write;

        if let Some(mut liveness) = self.parent_liveness.take() {
            liveness.write_all(b"ABORT\n")?;
            liveness.flush()?;
        }
        self.wait()
    }

    pub fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.trigger_cleanup();
        let status = self.child.wait();
        self.cleanup_control();
        status
    }

    fn cleanup_control(&self) {
        let _ = std::fs::remove_file(&self.target_path);
        let _ = std::fs::remove_file(self.target_path.with_extension("next"));
        let _ = std::fs::remove_file(&self.gate_path);
        let _ = std::fs::remove_file(self.gate_path.with_extension("next"));
        let _ = std::fs::remove_dir(&self.control_directory);
    }
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
    signal_group_members(group_id, anchor_id, signal)
}

/// Signals every process attached to the controlling terminal owned by
/// `terminal_owner_pid`, except `spared_pid` when nonzero. Unlike group
/// signaling, terminal enumeration also reaches foreground job groups created
/// by an interactive CLI or tool.
#[cfg(unix)]
pub fn signal_terminal_members(terminal_owner_pid: u32, spared_pid: u32, signal: Signal) -> bool {
    use std::process::Stdio;

    let terminal_output = match std::process::Command::new("/bin/ps")
        .args(["-o", "tty=", "-p", &terminal_owner_pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::error!(
                status = ?output.status.code(),
                terminal_owner_pid,
                "indeterminate terminal-session enumeration"
            );
            return false;
        }
        Err(error) => {
            tracing::error!(%error, terminal_owner_pid, "cannot enumerate terminal session");
            return false;
        }
    };
    let terminal_fields = String::from_utf8_lossy(&terminal_output.stdout)
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if terminal_fields.len() != 1 || terminal_fields[0] == "??" {
        tracing::error!(
            terminal_owner_pid,
            "terminal session has no unambiguous tty"
        );
        return false;
    }
    let terminal_name = &terminal_fields[0];
    let output = match std::process::Command::new("/bin/ps")
        .args(["-t", terminal_name, "-o", "pid="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            tracing::error!(%error, terminal_owner_pid, %terminal_name, "cannot enumerate terminal tty");
            return false;
        }
    };
    if !output.status.success() {
        if output.status.code() != Some(1) {
            tracing::error!(
                status = ?output.status.code(),
                terminal_owner_pid,
                %terminal_name,
                "indeterminate terminal-tty enumeration"
            );
        }
        return output.status.code() == Some(1);
    }
    let members = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|raw| raw.parse::<u32>().ok())
        .collect::<Vec<_>>();
    signal_pids(members, spared_pid, signal)
}

#[cfg(unix)]
fn signal_group_members(group_id: u32, spared_pid: u32, signal: Signal) -> bool {
    use std::process::Stdio;

    let output = match std::process::Command::new("/usr/bin/pgrep")
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

    let members = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|raw| raw.parse::<u32>().ok())
        .collect::<Vec<_>>();
    signal_pids(members, spared_pid, signal)
}

#[cfg(unix)]
fn signal_pids(pids: Vec<u32>, spared_pid: u32, signal: Signal) -> bool {
    use std::process::Stdio;

    let mut all_signaled = true;
    for pid in pids.into_iter().filter(|pid| *pid != spared_pid) {
        let signaled = std::process::Command::new("/bin/kill")
            .arg(signal.flag())
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if signaled {
            continue;
        }
        // The enumerated process may have exited between the snapshot and
        // delivery (notably the short-lived `ps` process on macOS). Treat a
        // now-absent pid as already complete; a still-live pid is a failure.
        let still_alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        all_signaled &= !still_alive;
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

#[cfg(not(unix))]
pub fn signal_terminal_members(
    _terminal_owner_pid: u32,
    _spared_pid: u32,
    _signal: Signal,
) -> bool {
    false
}

#[cfg(all(test, unix))]
mod tests {
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use super::*;

    const CRASH_FIXTURE_PHASE: &str = "DECOCMS_PTY_WATCHDOG_CRASH_PHASE";
    const CRASH_FIXTURE_ROOT: &str = "DECOCMS_PTY_WATCHDOG_CRASH_ROOT";

    struct KillOnDrop(Option<std::process::Child>);

    impl KillOnDrop {
        fn child_mut(&mut self) -> &mut std::process::Child {
            self.0.as_mut().expect("fixture owner is still present")
        }

        fn kill_and_wait(&mut self) {
            if let Some(mut child) = self.0.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            self.kill_and_wait();
        }
    }

    fn wait_for_nonempty_file(path: &Path, deadline: Instant) {
        while Instant::now() < deadline {
            if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("timed out waiting for {}", path.display());
    }

    fn wait_for_registration(control: &PtySessionControl, expected_pid: u32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match control.registered_terminal_owner_pid() {
                Ok(Some(pid)) if pid == expected_pid => return,
                Ok(Some(pid)) => panic!("wrapper registered pid {pid}, expected {expected_pid}"),
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(error) => panic!("could not read wrapper registration: {error}"),
            }
        }
        panic!("PTY wrapper did not register before the fixture deadline");
    }

    fn process_is_alive(pid: u32) -> bool {
        Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn read_pid(path: &Path) -> u32 {
        std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()))
            .trim()
            .parse()
            .unwrap_or_else(|error| panic!("invalid pid in {}: {error}", path.display()))
    }

    fn crash_fixture_command(phase: &str, root: &Path) -> KillOnDrop {
        let test_binary = std::env::current_exe().expect("resolve harness test binary");
        let child = Command::new(test_binary)
            .args([
                "--exact",
                "watchdog::tests::pty_watchdog_crash_fixture",
                "--nocapture",
            ])
            .env(CRASH_FIXTURE_PHASE, phase)
            .env(CRASH_FIXTURE_ROOT, root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn crash-fixture owner");
        KillOnDrop(Some(child))
    }

    /// Subprocess body for the owner-SIGKILL matrix below. A direct invocation
    /// by the ordinary test runner is a no-op; the orchestrator supplies the
    /// private phase and root variables to activate it.
    #[test]
    fn pty_watchdog_crash_fixture() {
        let Some(phase) = std::env::var_os(CRASH_FIXTURE_PHASE) else {
            return;
        };
        let root = PathBuf::from(
            std::env::var_os(CRASH_FIXTURE_ROOT).expect("crash fixture root is provided"),
        );
        let phase = phase.to_string_lossy();
        let lock_path = root.join("child-lifetime.lock");
        let mut control = PtySessionControl::create(root.join("control"))
            .expect("create PTY watchdog control directory");
        let lock = open_shared_lifetime_lock(&lock_path).expect("open shared lifetime fence");
        let watchdog = spawn_session_watchdog(
            "decocms-terminal-session-crash-test-watchdog",
            &mut control,
            Some(lock),
        )
        .expect("spawn PTY watchdog");

        let mut retained_master = None;
        let mut retained_child = None;
        if phase != "watcher-only" {
            let pty = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("open crash-fixture PTY");
            let pause_path = root.join("allow-registration");
            let registration_pause =
                (phase == "before-registration").then_some(pause_path.as_path());
            let workload_marker = root.join("workload-started");
            let descendant_pid_path = root.join("descendant.pid");
            let workload_script = r#"
printf 'started\n' > "$1"
(
  trap '' HUP TERM
  while :; do /bin/sleep 1; done
) &
printf '%s\n' "$!" > "$2"
trap '' HUP TERM
while :; do /bin/sleep 1; done
"#;
            let args = [
                OsString::from("-c"),
                OsString::from(workload_script),
                OsString::from("decocms-terminal-session-crash-test-workload"),
                workload_marker.as_os_str().to_owned(),
                descendant_pid_path.as_os_str().to_owned(),
            ];
            let command = control.command_with_registration_pause(
                std::process::id(),
                OsStr::new("/bin/sh"),
                &args,
                registration_pause,
            );
            let child = pty
                .slave
                .spawn_command(command)
                .expect("spawn crash-fixture PTY wrapper");
            let wrapper_pid = child.process_id().expect("PTY wrapper reports its pid");
            std::fs::write(root.join("wrapper.pid"), format!("{wrapper_pid}\n"))
                .expect("write wrapper pid");

            if phase != "before-registration" {
                wait_for_registration(&control, wrapper_pid);
            }
            if phase == "running" {
                control.release().expect("release crash-fixture workload");
                wait_for_nonempty_file(
                    &descendant_pid_path,
                    Instant::now() + Duration::from_secs(5),
                );
            }
            retained_master = Some(pty.master);
            retained_child = Some(child);
        }

        std::fs::write(root.join("ready"), b"ready\n").expect("publish fixture readiness");
        let _watchdog = watchdog;
        let _retained_master = retained_master;
        let _retained_child = retained_child;
        loop {
            std::thread::park_timeout(Duration::from_secs(60));
        }
    }

    /// The restart fence is acquired by the watcher before any PTY child can
    /// exist and remains held through cleanup of every registered tty. The
    /// one unavoidable pre-registration fork window is also exercised: its
    /// wrapper may briefly outlive the fence's bounded wait, but the workload
    /// marker proves it can never cross the `GO` admission gate.
    #[test]
    fn pty_watchdog_fences_every_owner_sigkill_startup_phase() {
        for phase in [
            "watcher-only",
            "before-registration",
            "registered-before-go",
            "running",
        ] {
            let directory = tempfile::tempdir().expect("crash matrix temp directory");
            let root = directory.path();
            let mut owner = crash_fixture_command(phase, root);
            let ready_deadline = Instant::now() + Duration::from_secs(8);
            while !root.join("ready").exists() && Instant::now() < ready_deadline {
                if let Some(status) = owner
                    .child_mut()
                    .try_wait()
                    .expect("poll crash-fixture owner")
                {
                    panic!("{phase} fixture exited before readiness with {status}");
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(root.join("ready").exists(), "{phase} fixture became ready");

            let lock_path = root.join("child-lifetime.lock");
            let contender = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&lock_path)
                .expect("open exclusive fence contender");
            assert!(
                matches!(contender.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
                "{phase}: live watcher must hold the shared fence"
            );

            let wrapper_pid = root
                .join("wrapper.pid")
                .exists()
                .then(|| read_pid(&root.join("wrapper.pid")));
            let descendant_pid = root
                .join("descendant.pid")
                .exists()
                .then(|| read_pid(&root.join("descendant.pid")));
            owner.kill_and_wait();

            let fence_deadline = Instant::now() + Duration::from_secs(8);
            loop {
                match contender.try_lock() {
                    Ok(()) => break,
                    Err(std::fs::TryLockError::WouldBlock) if Instant::now() < fence_deadline => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(error) => panic!("{phase}: lifetime fence did not release: {error}"),
                }
            }

            let process_deadline = Instant::now() + Duration::from_secs(3);
            for pid in [wrapper_pid, descendant_pid].into_iter().flatten() {
                while process_is_alive(pid) && Instant::now() < process_deadline {
                    std::thread::sleep(Duration::from_millis(20));
                }
                assert!(
                    !process_is_alive(pid),
                    "{phase}: process {pid} survived owner death"
                );
            }
            if phase != "running" {
                assert!(
                    !root.join("workload-started").exists(),
                    "{phase}: inert wrapper crossed the workload admission gate"
                );
            }
        }
    }

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
        let termed = std::process::Command::new("/bin/kill")
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

        let mut workload_cmd = tokio::process::Command::new("/bin/sleep");
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
