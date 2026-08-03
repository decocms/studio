//! The ONE home for parent-liveness watchdogs, shared by local-api background
//! process groups and interactive controlling-terminal sessions.
//!
//! Background workloads share the watcher's process group. PTY workloads have
//! foreground job-control groups, so their watcher instead records the
//! controlling terminal and enumerates the session behind it — by tty, and on
//! Linux also by session id, because there the tty stops naming the session
//! the moment the PTY master closes (see [`SESSION_ENUMERATION`]). Both
//! watchers own the shared child-lifetime lock as an exec-inherited descriptor
//! and release it only after their target is proven empty.
//!
//! Process-group script contract (pinned by this module's tests):
//! - ignores TERM itself, so graceful TERM reaches the workload while the
//!   ownership anchor survives for a later KILL/reap;
//! - blocks on its stdin liveness pipe; EOF starts TERM rounds, then KILL
//!   rounds, against every non-anchor group member;
//! - exits 0 only once `pgrep` proves no non-anchor member remains — which is
//!   also when its inherited shared lifetime lock is finally released;
//! - an enumeration error parks it forever: an indeterminate cleanup fails
//!   closed rather than unblocking durable recovery.
//!
//! `pgrep` note: the two implementations differ on what they omit from their
//! own output. BSD `pgrep` (macOS) excludes its ancestors, so the anchor —
//! `pgrep`'s parent shell — never appears; procps-ng `pgrep` (Linux) excludes
//! only itself, so `pgrep -g $$ .` DOES list the anchor. Measured: against an
//! empty group Linux exits 0 listing `$$` where macOS exits 1. The script's
//! own `$$` skip is therefore the load-bearing exclusion on both platforms,
//! and it must survive any edit to the enumeration loops.
//!
//! A single-command `$(pgrep ...)` substitution adds no pid of its own on
//! either platform — the shell execs `pgrep` directly and `pgrep` omits
//! itself. Piping inside the substitution WOULD add one, so keep it a bare
//! command. The explicit `.` pattern is required by BSD `pgrep` and matches
//! every process name under procps-ng.
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Interrupt,
    Term,
    Kill,
}

impl Signal {
    /// The `kill(1)` flag spelling — the one place this mapping lives.
    fn flag(self) -> &'static str {
        match self {
            Signal::Interrupt => "-INT",
            Signal::Term => "-TERM",
            Signal::Kill => "-KILL",
        }
    }
}

/// What counts as a member the reaper must still wait for — the liveness
/// filter shared by both [`SESSION_ENUMERATION`] variants.
///
/// A process whose last task has exited does not count. It runs nothing and
/// holds nothing, yet `kill -0` succeeds on it and both selectors list it for
/// as long as its parent lives (measured `Z+` under procps-ng 4.0.4 and BSD
/// `ps` alike). Counting one as live makes [`SESSION_REAPER`]'s unbounded KILL
/// round spin forever on a process no signal can remove, so the shared
/// lifetime fence it holds is never released. Enumerating by tty alone used to
/// dodge that by accident: an orphaned zombie's tty goes to `?` and drops out
/// of `ps -t`. Its session id survives, so enumerating by session id has to say
/// no explicitly — and wherever the reparent target does not `wait()` (a
/// container without an init, a non-reaping subreaper) those zombies are
/// permanent.
///
/// State `Z` alone does not establish that, though — not on Linux. A thread
/// group whose leader exits while its other threads run on (`pthread_exit`
/// from `main`, a plain `SYS_exit`) leaves the leader's task a zombie for the
/// rest of the process's life, and `ps` reports thread-group leaders, so that
/// is the row both selectors show: measured `Zl` with `nlwp=2` for a process
/// `kill -TERM` still kills and whose surviving thread keeps executing. A
/// detached background helper an interactive CLI leaves behind looks exactly
/// like that, and skipping it releases the fence over a live process.
///
/// A remaining task is not a runnable one, though, so the thread count cannot
/// be the rule by itself. `nlwp` counts tasks the kernel has not RELEASED, and
/// a non-leader thread that exits while ptraced stays a zombie until its tracer
/// `wait()`s for it — which a tracer attached from outside this session may
/// never do. Measured: a SIGKILLed process whose thread is held that way keeps
/// `nlwp=2` permanently, and its row is byte-identical to the live one above.
///
/// ```text
/// 45579 Zl      2   LIVE: per-task states `Zl Sl`, still executing
/// 45586 Zl      2   DEAD: per-task states `Zl Zl`, every further signal a no-op
/// ```
///
/// So what the rule has to ask is whether any task can still run, and only the
/// per-task view answers it: `ps -L -o stat=` prints one state per task.
/// Consulting it for every row would be a fork per member per 50 ms round, so
/// the thread count stays the cheap filter it is genuinely good for — `nlwp=1`
/// is a husk with no second task to ask about — and only a `Z` row with
/// `nlwp>1` (rare) is probed. Where `ps` reports no thread count at all (macOS
/// answers `keyword not found`) every zombie row reads as that single-task
/// case, which is the plain `Z` rule that platform is limited to;
/// `rows_carry_thread_count` says which, and a row that promised the column but
/// did not carry it is indeterminate. (Like `-s` and `sid=` elsewhere in the
/// Linux variant, `nlwp=` is assumed to be a spelling procps understands; a
/// `ps` that rejected it would exit 1 with no rows, which reads as an empty
/// selection.)
///
/// A task still in uninterruptible `D` — a hung NFS or FUSE mount, and this app
/// mounts an org filesystem over FUSE — counts as one that can run, so a member
/// holding one keeps [`SESSION_REAPER`]'s KILL round going. That is deliberate
/// and it is NOT what this rule is for: such a task resumes and takes its
/// pending signal once the I/O completes, so waiting is the fail-closed
/// direction. A mount that never completes leaves the pre-existing "no signal
/// can remove it" hazard [`SESSION_REAPER`] already documents, unchanged by
/// this rule either way.
#[cfg(unix)]
const SESSION_LIVENESS: &str = r#"
every_task_exited() {
  # Answers "no task of $1 can still run" from the per-task view: exit 0 when
  # every task is a zombie, 1 when at least one is not, 2 when the listing
  # cannot be read at all. Callers fail closed on 2.
  task_states="$(/bin/ps -L -o stat= -p "$1" 2>/dev/null)"
  task_status=$?
  # `ps` exits 1 when its selector matched nothing: the process ended between
  # the row and this probe, so there is nobody left to wait for. Every other
  # nonzero status is indeterminate.
  if [ "$task_status" -eq 1 ]; then return 0; fi
  [ "$task_status" -eq 0 ] || return 2
  # Splitting the listing into tasks is the point of leaving it unquoted, but
  # pathname expansion comes with that and is not wanted: a state character
  # `ps` prints must never be resolved against whatever the workload left in
  # this shell's directory. `set -f` says so, and the subshell is what scopes
  # it to this loop — it also carries the verdict out as its exit status.
  (
    set -f
    saw_task=0
    for task_state in $task_states; do
      saw_task=1
      case "$task_state" in
        Z*) ;;
        *) exit 1 ;;
      esac
    done
    # Exiting 0 while listing no task at all is not an answer either.
    [ "$saw_task" -eq 1 ] || exit 2
    exit 0
  )
}

live_session_pids() {
  # Reads `ps -o pid=,stat=[,nlwp=]` rows and prints the pid of every row that
  # is still a live member. $1 is 1 when the rows carry the trailing thread
  # count and 0 when this platform's `ps` cannot report one. A row that is not
  # the promised tuple is indeterminate: fail closed rather than guess which
  # column was which.
  rows_carry_thread_count="$1"
  while read -r row_pid row_state row_threads; do
    case "$row_pid" in
      '') continue ;;
      *[!0-9]*) return 1 ;;
    esac
    case "$row_state" in
      '') return 1 ;;
    esac
    if [ "$rows_carry_thread_count" -eq 1 ]; then
      case "$row_threads" in
        ''|*[!0-9]*) return 1 ;;
      esac
    else
      # No thread count to consult, so every zombie state reads as the
      # single-task case: the plain `Z` rule this platform is limited to. It
      # is also what keeps `every_task_exited` unreachable here — load-bearing,
      # because `ps -L` does not mean "one row per task" on BSD, it means
      # "list the keywords".
      row_threads=1
    fi
    case "$row_state" in
      Z*)
        # One unreleased task is the husk: there is no other task to ask
        # about. More than one only means more than one is unreleased, which
        # is true both of an exited leader in front of a running thread and of
        # a process every task of which is already a zombie. Ask.
        if [ "$row_threads" -eq 1 ]; then continue; fi
        every_task_exited "$row_pid"
        task_verdict=$?
        if [ "$task_verdict" -eq 0 ]; then continue; fi
        [ "$task_verdict" -eq 1 ] || return 1
        ;;
    esac
    printf '%s\n' "$row_pid"
  done
  return 0
}
"#;

/// How a PTY session is named and enumerated, split from [`SESSION_REAPER`]
/// because the two kernels disagree about what a session still is once its PTY
/// master is closed — which, on the crash-recovery path, is the very moment the
/// owner is SIGKILLed.
///
/// Linux hangs the controlling terminal up for the WHOLE session (`tty_vhangup`)
/// as soon as the master closes: every member's tty becomes `?`, so `ps -t`
/// matches none of them while they all keep running. A tty-only reaper would
/// read that as an empty session and release the shared lifetime fence over
/// live processes. The session id survives the hangup — measured: after the
/// master closes, `ps -t pts/0` exits 1 with no pids while `ps -s <sid>` still
/// lists the leader, the workload and its descendants.
///
/// That exit 1 is the load-bearing ambiguity: procps spells "this tty is gone"
/// and "this tty has no processes" with the same status (only the discarded
/// stderr differs, `error: TTY could not be found`), so on Linux the tty alone
/// can never prove a session empty. What separates the two is the slave device
/// — measured: `/dev/pts/N` disappears with the master's close, the same close
/// that hangs the session up — so the Linux variant lets the tty answer only
/// while its device is still there, and needs the session id otherwise.
///
/// macOS/BSD keeps the session→terminal association across that same close, so
/// `ps -t` stays the complete answer there for as long as the session leader
/// lives — measured: master closed, wrapper alive, `ps -t ttysNNN` still lists
/// the wrapper, the workload and its descendant. It is the LEADER's exit, not
/// the master's close, that ends the association: after it every survivor reads
/// `tty=??`/`sess=0` and no selector can see it, which is why the anchor keeps
/// the wrapper alive (see [`pty_session_anchor_script`]) and why the gap noted
/// on the BSD `collect_session_members` below cannot be closed there.
/// `ps -o sess=` prints 0, so there is no session id to enumerate by either.
///
/// Both variants define the same two functions, so [`SESSION_REAPER`] and its
/// callers are platform-independent:
/// - `resolve_session_id <leader-candidate>` — the session id to enumerate by,
///   empty when there is none to trust. Only an observed self-led session
///   yields one; a candidate `ps` cannot answer for is unverified, never
///   assumed-ours. That leaves two very different reasons for an empty
///   answer — a candidate leading somebody else's session, and one that is
///   simply gone — which this function deliberately does not distinguish.
///   Anything that wants to act on the difference has to establish it
///   itself, as [`pty_session_watchdog_script`] does;
/// - `collect_session_members <tty> <session-id>` — prints every live pid
///   (see [`SESSION_LIVENESS`]) found by every enumeration that can still
///   answer, and fails (nonzero) when any of them is indeterminate. On Linux,
///   where there are two selectors, it also fails when NEITHER can answer, so
///   it reads as "empty" only when something that could have seen a member saw
///   none. BSD has one selector and no second identity to fall back on, so
///   there the no-witness case reads as empty instead — deliberately, and
///   measured; the body below states what that costs and why requiring a
///   witness there is worse.
#[cfg(all(unix, not(target_os = "linux")))]
const SESSION_ENUMERATION: &str = r#"
resolve_session_id() {
  # BSD has no session id to enumerate by: `ps -o sess=` prints 0. The
  # leader candidate is deliberately unused.
  printf ''
}

collect_session_members() {
  member_terminal="$1"
  # The session id is deliberately unused: `resolve_session_id` never produces
  # one here.
  #
  # No tty left to ask means no witness at all, and this reports that as an
  # empty session — the one place this file lets silence read as proof. It is
  # not an oversight and requiring a witness here is measurably worse:
  #
  # - `refresh_terminal_witness` DOES latch on macOS. `/dev/ttysNNN` is not the
  #   static node it looks like; measured on darwin 25.5.0, it disappears once
  #   the master AND every slave fd are closed, which on the crash path is the
  #   final round, after the wrapper has been TERMed.
  # - By then nothing is enumerable anyway. The wrapper's exit ended the
  #   session→terminal association, so every survivor reads `tty=??`/`sess=0`
  #   and no selector names it: `ps -t` exits 1 and `ps -o sess=` prints 0.
  #   (The two are not separable on darwin 26.5.2 — the leader's exit revokes
  #   the terminal and takes the node with it even while a survivor holds the
  #   slave fds, and even with another process holding the node open, so
  #   "node still present, leader gone" is not a state to measure.)
  # - Returning nonzero here therefore buys no kill and costs a permanent park.
  #   Measured: it holds the shared fence past the 30 s deadline of
  #   `pty_watchdog_fences_every_owner_sigkill_startup_phase`'s
  #   `registered-before-go` phase, 3/3.
  #
  # So this is a real macOS gap — a survivor that outlives the wrapper is not
  # reaped and the fence releases without proof — and it is exactly the gap the
  # tty-only reaper had before the session id was added for Linux. Closing it
  # needs an identity macOS does not offer, not a stricter reading of silence.
  #
  # Answering it here rather than at `ps -t ""` is also what keeps the verdict
  # deterministic: BSD `ps` formats that error from uninitialized stack (a
  # different garbage device name every run) and only happens to exit 1.
  [ -n "$member_terminal" ] || return 0
  terminal_rows="$(/bin/ps -t "$member_terminal" -o pid=,stat= 2>/dev/null)"
  enumeration_status=$?
  # `ps` exits 1 when its selector matched nothing: a definite empty session.
  # Every other nonzero status is indeterminate and must not read as empty.
  [ "$enumeration_status" -eq 0 ] || [ "$enumeration_status" -eq 1 ] || return 1
  # 0: BSD `ps` has no thread-count keyword (`nlwp` is "keyword not found"),
  # so the plain zombie rule is all this platform can express.
  printf '%s\n' "$terminal_rows" | live_session_pids 0
}
"#;

#[cfg(target_os = "linux")]
const SESSION_ENUMERATION: &str = r#"
resolve_session_id() {
  session_candidate="$1"
  # The PTY wrapper is its session's leader, so its pid IS the session id.
  # Verify that rather than assume it, and count unobservable as unverified:
  # `ps` prints nothing both for a candidate that leads somebody else's
  # session — Studio's own, in the degenerate case — and for one it cannot
  # answer for at all, which a recycled pid is indistinguishable from. Only an
  # observed self-led session yields an id; anything else yields none, leaving
  # `collect_session_members` to require an answerable tty instead.
  observed_session="$(/bin/ps -o sid= -p "$session_candidate" 2>/dev/null | {
    read -r observed extra || exit 1
    [ -z "$extra" ] || exit 1
    printf '%s' "$observed"
  })" || observed_session=''
  if [ "$observed_session" = "$session_candidate" ]; then
    printf '%s' "$session_candidate"
  fi
}

collect_session_members() {
  member_terminal="$1"
  member_session="$2"
  terminal_members=''
  session_members=''
  enumerated=0
  # A tty whose slave device is gone cannot answer for its session: the close
  # that destroys `/dev/<tty>` is the close that hangs the session up, and
  # procps reports the resulting miss with the same exit 1 it uses for
  # "matched nothing". Requiring the device is what keeps that silence from
  # reading as proof of an empty session. It is a lower bound only — a device
  # that is back is a DIFFERENT pty on a recycled devpts index, which this
  # single observation cannot tell from the original. Repeated callers must
  # remember the first absence themselves; `reap_terminal` does.
  if [ -n "$member_terminal" ] && [ -e "/dev/$member_terminal" ]; then
    terminal_rows="$(/bin/ps -t "$member_terminal" -o pid=,stat=,nlwp= 2>/dev/null)"
    terminal_status=$?
    # `ps` exits 1 when its selector matched nothing: a definite empty
    # observation. Every other nonzero status is indeterminate.
    if [ "$terminal_status" -ne 0 ] && [ "$terminal_status" -ne 1 ]; then return 1; fi
    terminal_members="$(printf '%s\n' "$terminal_rows" | live_session_pids 1)" || return 1
    enumerated=1
  fi
  if [ -n "$member_session" ]; then
    session_rows="$(/bin/ps -s "$member_session" -o pid=,stat=,nlwp= 2>/dev/null)"
    session_status=$?
    if [ "$session_status" -ne 0 ] && [ "$session_status" -ne 1 ]; then return 1; fi
    session_members="$(printf '%s\n' "$session_rows" | live_session_pids 1)" || return 1
    enumerated=1
  fi
  # Having enumerated nothing is indeterminate, never an empty session.
  [ "$enumerated" -eq 1 ] || return 1
  printf '%s %s' "$terminal_members" "$session_members"
}
"#;

/// Escalating TERM→KILL reaper for one PTY session. Returns only once every
/// enumeration in [`SESSION_ENUMERATION`] agrees no unspared live member is
/// left; an indeterminate enumeration parks it forever, so an answer that
/// cannot be trusted fails closed instead of releasing the shared lifetime
/// fence. Termination depends on [`SESSION_LIVENESS`] excluding every process
/// no task of which can still run: the KILL round below is unbounded by
/// design, and a process that `kill -0` answers for but no signal can remove
/// would spin it forever.
///
/// The loops re-enumerate every 50 ms, which is what makes the tty a witness
/// that has to be remembered rather than re-derived — see
/// `refresh_terminal_witness`.
#[cfg(unix)]
const SESSION_REAPER: &str = r#"
# Latched by `refresh_terminal_witness`, never cleared: it outlives the
# individual `reap_terminal` calls of one teardown on purpose.
terminal_hangup_observed=0

refresh_terminal_witness() {
  # Publishes in `terminal_witness` the tty `collect_session_members` may still
  # consult, which is "$1" until the first time that tty proves hung up and
  # nothing afterwards.
  #
  # A tty whose slave device is gone is not merely silent for now. The close
  # that destroyed `/dev/pts/N` also released that devpts index, so the next
  # `openpty()` on the box takes it — and then the device is back, naming a
  # session that has nothing to do with this one. Asking `[ -e ]` afresh each
  # iteration would flip such a tty from "cannot answer" to "answers" and hand
  # the loops below foreign pids to TERM and KILL. The exposure is the whole
  # time the loops keep running, i.e. about a second of 50 ms rounds against
  # exactly the TERM-ignoring survivor this fence exists for.
  #
  # So the first absence latches. It has to latch HERE: `collect_session_members`
  # runs inside a command substitution, a fresh subshell whose variables are
  # gone before the next round reads them.
  #
  # This does not make the tty provably ours, and must not be read as saying so.
  # A reallocation that completes before the FIRST check still presents a device
  # this cannot tell from the original, and nothing cheaper closes that: the
  # identity one would pin against is destroyed by the same close, so by the
  # time a reaper runs there is no original left to compare to. What the latch
  # buys is the difference between a few milliseconds of exposure — owner death
  # to first round — and the whole second the loops spend re-asking.
  #
  # It fires on BSD too. `/dev/ttysNNN` looks static but is not: measured on
  # darwin 25.5.0, the node disappears once the master AND every slave fd are
  # closed, i.e. after the wrapper exits — so on the crash path the final
  # `reap_terminal ""` round runs with an empty witness there. What that means
  # for BSD, and why it is neither a regression nor fixable by refusing to
  # answer, is on that platform's `collect_session_members`.
  if [ -n "$1" ] && [ ! -e "/dev/$1" ]; then
    terminal_hangup_observed=1
  fi
  if [ "$terminal_hangup_observed" -eq 1 ]; then
    terminal_witness=''
  else
    terminal_witness="$1"
  fi
}

reap_terminal() {
  spared_pid="$1"
  terminal_name="$2"
  session_id="$3"
  term_round=0
  while [ "$term_round" -lt 20 ]; do
    refresh_terminal_witness "$terminal_name"
    if ! members="$(collect_session_members "$terminal_witness" "$session_id")"; then
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
    refresh_terminal_witness "$terminal_name"
    if ! members="$(collect_session_members "$terminal_witness" "$session_id")"; then
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
        r#"{SESSION_LIVENESS}{SESSION_ENUMERATION}{SESSION_REAPER}
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
# and every process it left in the session are gone. If the shell exec'd the
# CLI, macOS would detach surviving descendants from the tty as soon as that
# direct process exited, making them undiscoverable (`tty=??`, `sess=0`).
"$@"
workload_status=$?
session_id="$(resolve_session_id "$$")"
reap_terminal "$$" "$terminal_name" "$session_id"
exit "$workload_status"
"#
    )
}

#[cfg(unix)]
fn pty_session_watchdog_script() -> String {
    format!(
        r#"{SESSION_LIVENESS}{SESSION_ENUMERATION}{SESSION_REAPER}
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

# Resolve the session id while its leader is still alive to be asked, then
# preserve that leader while every CLI/tool process is reaped. Only then
# terminate the leader and prove the session empty by every enumeration.
session_id="$(resolve_session_id "$terminal_owner_pid")"
# The same owner death that starts this teardown also strips the wrapper of
# its parent, so it may already have exited before there was anybody to ask.
# The registered pid is then the only name its session ever had, and it is
# still a usable one: a pid stays reserved for as long as it names a live
# session, so enumerating under it reaches this session's survivors and
# nothing else for as long as any of them exists. It becomes free to be
# recycled only once none does — and a recycled pid is a LIVE pid, which is
# exactly what the `ps` probe below excludes and what `resolve_session_id`
# has already refused an id for. Refusing to enumerate here instead would
# park the watchdog, and with it the shared lifetime fence, on the ordinary
# "the wrapper is gone too" teardown. Inert on BSD, where there is never an
# id to resolve and `collect_session_members` never reads one.
#
# The reserve is only as good as the reason for it, and that reason ENDS with
# the last member: the pid is free the instant the session empties, and the
# loops below keep re-asking for about a second afterwards. So the sid axis
# has the same recycle window the tty axis has — a fresh process that takes
# the pid becomes a session of its own, `ps -s` starts listing it, and these
# loops would TERM and KILL it — and unlike the tty it is NOT latched. Two
# things bound it and neither is a proof: `-s <pid>` only matches a process
# that made itself a session LEADER (not merely one that reused the pid), and
# the window opens only after the last old member is gone, which is when the
# next round returns anyway. It is left unlatched because latching wants a
# first observation of absence to remember, and "this sid is empty" is
# indistinguishable from "this session is finally reaped" — the very verdict
# this loop exists to reach.
if [ -z "$session_id" ] && ! /bin/ps -o pid= -p "$terminal_owner_pid" >/dev/null 2>&1; then
  session_id="$terminal_owner_pid"
fi
# The complement of that branch is a permanent leak, and it is deliberate: an
# owner pid that IS live but leads somebody else's session yields no id here
# (`resolve_session_id` refuses one) and no id above, so if the tty has also
# latched, `collect_session_members` can never enumerate again and this
# watchdog — with the shared lifetime fence it holds — parks forever. That
# needs the registered pid to have been recycled onto a live process, which
# takes the whole pid space between registration and owner death. It is the
# fail-closed direction and it is unchanged by the latch: without one, the
# same state would enumerate a stranger's tty instead.
reap_terminal "$terminal_owner_pid" "$terminal_name" "$session_id"
/bin/kill -TERM "$terminal_owner_pid" 2>/dev/null || true
reap_terminal "" "$terminal_name" "$session_id"
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
        if fields.next().is_some() || !is_enumerable_terminal(terminal_name) {
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
/// every member of the published session and releases the fence only after
/// every enumeration in [`SESSION_ENUMERATION`] proves that session empty.
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
///
/// Group id `0` is refused rather than passed through. procps documents
/// `pgrep -g 0` as "pgrep's OWN process group", so on Linux a zero id makes
/// this enumerate the caller's group and then signal every member of it —
/// under `cargo test` that is the test runner and, on CI, the agent itself.
/// BSD `pgrep` takes 0 literally and matches nothing, so the same call is a
/// silent no-op on macOS: the sort of divergence that only ever surfaces as
/// an unexplained dead machine.
#[cfg(unix)]
pub fn signal_non_anchor_members(group_id: u32, anchor_id: u32, signal: Signal) -> bool {
    signal_group_members(group_id, anchor_id, signal)
}

/// Signals every process in the terminal session led by `terminal_owner_pid`,
/// except `spared_pid` when nonzero. Unlike group signaling, session
/// enumeration also reaches foreground job groups created by an interactive
/// CLI or tool.
///
/// Returns `true` when every enumerated member was signaled — including when
/// the session was already empty. Any indeterminate enumeration signals
/// nothing and returns `false`: an answer we cannot trust must never read as
/// "nothing left to signal". The enumeration itself is platform-branched for
/// the reason spelled out on [`SESSION_ENUMERATION`]; the same asymmetry that
/// makes the shell reaper enumerate by session id on Linux applies here.
/// Blocking: callers on an async runtime wrap this in `spawn_blocking`.
#[cfg(unix)]
pub fn signal_terminal_members(terminal_owner_pid: u32, spared_pid: u32, signal: Signal) -> bool {
    if terminal_owner_pid <= 1 {
        tracing::error!(
            terminal_owner_pid,
            "refusing to enumerate a system process's terminal session"
        );
        return false;
    }
    let Some(members) = terminal_session_members(terminal_owner_pid) else {
        return false;
    };
    signal_pids(members, spared_pid, signal)
}

/// A `ps -o tty=` value that can be handed back to `ps -t`. Both spellings of
/// "no controlling terminal" — BSD's `??` and Linux's `?` — fall outside a
/// device name's alphabet and are refused. On Linux that is load-bearing well
/// beyond hygiene: `ps -t '?'` does not fail, it succeeds by matching every
/// process on the machine that has no controlling terminal.
#[cfg(unix)]
fn is_enumerable_terminal(terminal_name: &str) -> bool {
    !terminal_name.is_empty()
        && terminal_name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '.' | '-')
        })
}

/// Reads `ps -o <fields> -p <pid>` as exactly `expected` whitespace-separated
/// columns. `None` — a dead pid included — is indeterminate: callers fail
/// closed rather than treat it as an answer.
#[cfg(unix)]
fn process_columns(pid: u32, fields: &str, expected: usize) -> Option<Vec<String>> {
    use std::process::Stdio;

    let output = match std::process::Command::new("/bin/ps")
        .args(["-o", fields, "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            tracing::error!(
                status = ?output.status.code(),
                pid,
                fields,
                "indeterminate terminal-session enumeration"
            );
            return None;
        }
        Err(error) => {
            tracing::error!(%error, pid, fields, "cannot enumerate terminal session");
            return None;
        }
    };
    let columns = String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if columns.len() != expected {
        tracing::error!(pid, fields, "terminal session reported ambiguous fields");
        return None;
    }
    Some(columns)
}

/// The `ps` row spec [`enumerate_session_pids`] reads, matching the one the
/// shell's [`SESSION_ENUMERATION`] variant for this platform uses: Linux also
/// asks for the remaining task count, because there state `Z` alone does not
/// mean the process is gone. The count is a filter, not the verdict — a `Z`
/// row carrying more than one task is settled by a second `ps` (see
/// [`SESSION_LIVENESS`] and [`every_task_exited`]).
#[cfg(target_os = "linux")]
const SESSION_ROW_FIELDS: &str = "pid=,stat=,nlwp=";
#[cfg(all(unix, not(target_os = "linux")))]
const SESSION_ROW_FIELDS: &str = "pid=,stat=";

/// Whether a [`SESSION_ROW_FIELDS`] row is a husk no signal can remove, per
/// the rule [`SESSION_LIVENESS`] spells out. `None` is indeterminate: on Linux
/// the thread count is consulted first, so a row that did not carry a readable
/// one cannot be classified whatever its state — which is also the order the
/// shell's `live_session_pids` validates in.
#[cfg(target_os = "linux")]
fn row_is_exited_process(pid: u32, state: &str, thread_count: Option<&str>) -> Option<bool> {
    let remaining_tasks = thread_count?.parse::<u32>().ok()?;
    if !state.starts_with('Z') {
        return Some(false);
    }
    // One unreleased task is the husk; more than one is the ambiguous row that
    // only the per-task view can settle. See [`SESSION_LIVENESS`].
    if remaining_tasks == 1 {
        return Some(true);
    }
    every_task_exited(pid)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn row_is_exited_process(_pid: u32, state: &str, _thread_count: Option<&str>) -> Option<bool> {
    Some(state.starts_with('Z'))
}

/// Whether no task of `pid` can still run, read from `ps -L -o stat=` — one
/// state per task, the only view that separates an exited thread-group leader
/// in front of a running thread from a process every task of which is already
/// a zombie. The shell twin is `every_task_exited`. `None` is indeterminate.
#[cfg(target_os = "linux")]
fn every_task_exited(pid: u32) -> Option<bool> {
    use std::process::Stdio;

    let output = match std::process::Command::new("/bin/ps")
        .args(["-L", "-o", "stat=", "-p", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            tracing::error!(%error, pid, "cannot enumerate a session member's tasks");
            return None;
        }
    };
    if !output.status.success() {
        // `ps` exits 1 when its selector matched nothing: the process ended
        // between the row and this probe, so there is nobody left to wait for.
        if output.status.code() != Some(1) {
            tracing::error!(
                status = ?output.status.code(),
                pid,
                "indeterminate task enumeration for a session member"
            );
            return None;
        }
        return Some(true);
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut saw_task = false;
    for task_state in listing.split_whitespace() {
        saw_task = true;
        if !task_state.starts_with('Z') {
            return Some(false);
        }
    }
    if !saw_task {
        tracing::error!(pid, "task enumeration listed no task for a session member");
        return None;
    }
    Some(true)
}

/// Runs one `ps` selection (`-t <tty>` or `-s <sid>`). `Some` is a definite
/// answer, empty included — `ps` exits 1 when its selector matched nothing.
/// Every other nonzero status is indeterminate and yields `None`, as does any
/// row that is not the tuple [`SESSION_ROW_FIELDS`] promises.
///
/// Exited processes are dropped for the reason spelled out on
/// [`SESSION_LIVENESS`]: both selectors list one while its parent lives, and it
/// is not a member anybody is waiting for. Here that only saves a no-op signal
/// — this enumeration does not loop — but the converse matters as much as it
/// does there: a Linux thread group whose leader exited may still be running,
/// and dropping it would make [`signal_terminal_members`] report success having
/// signalled nothing. One rule with two spellings is how the two
/// implementations drift apart, so this reads the columns in the shell's order
/// and fails closed on the same rows it does.
#[cfg(unix)]
fn enumerate_session_pids(selector: &str, value: &str) -> Option<Vec<u32>> {
    use std::process::Stdio;

    let output = match std::process::Command::new("/bin/ps")
        .args([selector, value, "-o", SESSION_ROW_FIELDS])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            tracing::error!(%error, selector, value, "cannot enumerate terminal session");
            return None;
        }
    };
    if !output.status.success() {
        if output.status.code() != Some(1) {
            tracing::error!(
                status = ?output.status.code(),
                selector,
                value,
                "indeterminate terminal-session enumeration"
            );
            return None;
        }
        return Some(Vec::new());
    }
    let listing = String::from_utf8_lossy(&output.stdout);
    let mut members = Vec::new();
    for row in listing.lines() {
        let mut columns = row.split_whitespace();
        let Some(raw_pid) = columns.next() else {
            continue;
        };
        // Parsed before the row is classified, exactly as the shell validates
        // `row_pid` before it looks at `row_state`: an unreadable pid fails
        // closed even on a row the classifier would have dropped.
        let Ok(pid) = raw_pid.parse::<u32>() else {
            tracing::error!(
                selector,
                value,
                "terminal session reported an unreadable pid"
            );
            return None;
        };
        let Some(state) = columns.next() else {
            tracing::error!(selector, value, "terminal session reported a stateless row");
            return None;
        };
        let Some(is_exited) = row_is_exited_process(pid, state, columns.next()) else {
            tracing::error!(
                selector,
                value,
                "terminal session reported a row that cannot be classified"
            );
            return None;
        };
        if is_exited {
            continue;
        }
        members.push(pid);
    }
    Some(members)
}

/// macOS/BSD keeps the session→controlling-terminal association alive across
/// the master's close, so the tty enumerates the whole session on its own —
/// and `ps -o sess=` prints 0, so it is also the only identity available.
#[cfg(all(unix, not(target_os = "linux")))]
fn terminal_session_members(terminal_owner_pid: u32) -> Option<Vec<u32>> {
    let columns = process_columns(terminal_owner_pid, "tty=", 1)?;
    let [terminal_name] = columns.as_slice() else {
        return None;
    };
    if !is_enumerable_terminal(terminal_name) {
        tracing::error!(
            terminal_owner_pid,
            %terminal_name,
            "terminal session has no enumerable tty"
        );
        return None;
    }
    enumerate_session_pids("-t", terminal_name)
}

/// Linux detaches the controlling terminal from the whole session when the PTY
/// master closes, so the tty is a witness that can go silent while every member
/// runs on. The session id outlives that hangup and carries the enumeration;
/// the tty stays a second, independent witness for as long as it is one, which
/// — per [`SESSION_ENUMERATION`] — is exactly as long as its slave device
/// exists. A tty that has lost its device answers `ps -t` with the same exit 1
/// as an empty one, so trusting it there would report a live session as empty.
///
/// The shell reaper has to remember that absence (see `refresh_terminal_witness`)
/// because a freed devpts index gets reused and its loops keep re-asking. This
/// path needs no such latch: it asks once, and the tty it asks about is the one
/// `ps` reports for a live owner in this very call — never a name registered
/// before a hangup. A hung-up session reports `?`, which
/// [`is_enumerable_terminal`] refuses, so there is no state in which a recycled
/// node could pass for the original.
#[cfg(target_os = "linux")]
fn terminal_session_members(terminal_owner_pid: u32) -> Option<Vec<u32>> {
    let columns = process_columns(terminal_owner_pid, "tty=,sid=", 2)?;
    let [terminal_name, observed_session_id] = columns.as_slice() else {
        return None;
    };
    // The PTY wrapper is its session's leader, so its pid IS the session id.
    // Verified, never assumed: an owner leading no session would make this
    // enumerate — and then signal — somebody else's session, Studio's own
    // included. (`process_columns` has already failed closed on an owner `ps`
    // cannot answer for, so unobservable never reaches here.)
    let leads_own_session = observed_session_id
        .parse::<u32>()
        .is_ok_and(|session_id| session_id == terminal_owner_pid);
    let terminal_can_answer = is_enumerable_terminal(terminal_name)
        && std::path::Path::new("/dev").join(terminal_name).exists();
    let mut members = Vec::new();
    let mut enumerated = false;
    if leads_own_session {
        members.extend(enumerate_session_pids(
            "-s",
            &terminal_owner_pid.to_string(),
        )?);
        enumerated = true;
    }
    if terminal_can_answer {
        members.extend(enumerate_session_pids("-t", terminal_name)?);
        enumerated = true;
    }
    if !enumerated {
        tracing::error!(
            terminal_owner_pid,
            %terminal_name,
            %observed_session_id,
            "terminal session has neither an answerable tty nor a session id of its own"
        );
        return None;
    }
    members.sort_unstable();
    members.dedup();
    Some(members)
}

#[cfg(unix)]
fn signal_group_members(group_id: u32, spared_pid: u32, signal: Signal) -> bool {
    use std::process::Stdio;

    if group_id == 0 {
        tracing::error!("refusing to signal process group 0 — that is this process's own group");
        return false;
    }

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
    let own_pid = std::process::id();
    for pid in pids
        .into_iter()
        .filter(|pid| *pid != spared_pid)
        // Belt to the group-0 brace: whatever enumeration returned, signalling
        // ourselves is never the intent, and a caller that has somehow been
        // handed its own group should not die for it.
        .filter(|pid| *pid != own_pid)
    {
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
    // Fork pressure can stretch the watcher's 100 bounded registration rounds.
    const CRASH_FIXTURE_FENCE_TIMEOUT: Duration = Duration::from_secs(30);

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
    /// exist and remains held until every member of the registered session is
    /// gone. The one unavoidable pre-registration fork window is also
    /// exercised: its wrapper may briefly outlive the fence's bounded wait,
    /// but the workload marker proves it can never cross the `GO` admission
    /// gate.
    ///
    /// The `running` phase is what pins [`SESSION_ENUMERATION`]'s Linux
    /// branch. SIGKILLing the owner closes the PTY master it held, and Linux
    /// answers that by hanging the controlling terminal up for the WHOLE
    /// session: the wrapper, the workload and its descendant keep running
    /// (`Ss`/`S`, spawning fresh children — not zombies) while `ps -t <tty>`
    /// stops matching any of them. A reaper that enumerated only by tty read
    /// that exit 1 as "the session is empty, we are done", signaled nothing,
    /// and released the shared lifetime fence over three live processes. So
    /// this test fails on Linux for any implementation that trusts a single
    /// enumeration, and it is the reason the session id is enumerated
    /// alongside the tty there.
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

            let fence_deadline = Instant::now() + CRASH_FIXTURE_FENCE_TIMEOUT;
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

    /// The BSD latch path, which [`SESSION_REAPER`] used to claim could not
    /// exist. `/dev/ttysNNN` is not the static node that claim assumed: it
    /// disappears once the PTY master AND every slave fd are closed, so
    /// `refresh_terminal_witness` latches on macOS too and the final
    /// `reap_terminal` round runs with an empty witness.
    ///
    /// What the BSD `collect_session_members` guarantees there is that the
    /// reaper RETURNS. It cannot guarantee the session is empty — the leader's
    /// exit already made every survivor `tty=??`/`sess=0`, unreachable by any
    /// selector macOS offers — and refusing to answer instead would hold the
    /// shared lifetime fence forever while killing nothing, hanging
    /// [`SpawnedSessionWatchdog::wait`] on the ordinary child-exit path.
    ///
    /// So this asserts the latch really fires (otherwise the test would pass
    /// while exercising nothing) and that the reaper still terminates. The
    /// surviving member is asserted alive because that is the documented cost:
    /// should macOS ever gain an identity that reaches it, this assertion is
    /// the pin to invert.
    #[cfg(not(target_os = "linux"))]
    #[test]
    fn a_latched_bsd_terminal_releases_the_reaper_instead_of_parking() {
        let directory = tempfile::tempdir().expect("latch probe temp directory");
        let registration = directory.path().join("probe-registration");
        let portable_pty::PtyPair { master, slave } = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open latch-probe PTY");

        // A session leader plus one member that has detached from every tty
        // descriptor — the survivor shape this fence exists for, and the one
        // whose tty macOS drops the moment the leader goes.
        let mut command = portable_pty::CommandBuilder::new("/bin/sh");
        command.arg("-c");
        command.arg(
            r#"
(exec </dev/null >/dev/null 2>&1; trap '' HUP INT TERM; while :; do /bin/sleep 1; done) &
printf '%s %s\n' "$!" "$(/bin/ps -o tty= -p $$)" > "$1"
exec /bin/sleep 300
"#,
        );
        command.arg("decocms-terminal-latch-probe");
        command.arg(registration.as_os_str());
        let mut leader = slave.spawn_command(command).expect("spawn the latch probe");
        drop(slave);
        wait_for_nonempty_file(&registration, Instant::now() + Duration::from_secs(10));
        let published = std::fs::read_to_string(&registration).expect("read probe registration");
        let mut fields = published.split_whitespace();
        let survivor: u32 = fields
            .next()
            .and_then(|raw| raw.parse().ok())
            .expect("probe published its survivor pid");
        let terminal_name = fields.next().expect("probe published its tty").to_owned();
        assert!(
            is_enumerable_terminal(&terminal_name),
            "the probe must run on a real tty, got {terminal_name}"
        );

        // Both closes, which is what it takes: with either side still open the
        // node stays and the latch would not fire.
        let _ = leader.kill();
        let _ = leader.wait();
        drop(master);
        let node = std::path::Path::new("/dev").join(&terminal_name);
        let node_deadline = Instant::now() + Duration::from_secs(10);
        while node.exists() && Instant::now() < node_deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !node.exists(),
            "{terminal_name} must lose its device once master and slave are closed"
        );
        assert!(
            process_is_alive(survivor),
            "the detached survivor must outlive its session leader"
        );

        let library = format!("{SESSION_LIVENESS}{SESSION_ENUMERATION}{SESSION_REAPER}");
        let mut reaper = Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{library}\nreap_terminal \"\" \"$1\" \"\"\n"))
            .arg("decocms-terminal-latch-probe-reaper")
            .arg(&terminal_name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn the latch-probe reaper");
        let reaper_deadline = Instant::now() + Duration::from_secs(15);
        let mut returned = false;
        while Instant::now() < reaper_deadline {
            if reaper.try_wait().expect("poll the probe reaper").is_some() {
                returned = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !returned {
            let _ = reaper.kill();
        }
        let _ = reaper.wait();
        let survived = process_is_alive(survivor);
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &survivor.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();

        assert!(
            returned,
            "a latched BSD terminal must not park the reaper on the shared fence"
        );
        assert!(
            survived,
            "the documented macOS gap closed: a survivor outliving the wrapper \
             was reaped, so this pin and the note on `collect_session_members` \
             both need updating"
        );
    }

    /// The Linux row-classification table, in the spelling
    /// [`enumerate_session_pids`] reads it — the same rule the shell's
    /// `live_session_pids` applies, including validating the thread count
    /// before looking at the state.
    ///
    /// The two rows that motivate the per-task probe in the first place — a
    /// `Zl nlwp=2` whose other task still runs versus one whose other task is
    /// a zombie its tracer will never reap — need a `pthread_exit`ing leader
    /// and a `PTRACE_SEIZE`, neither of which this crate can build under
    /// `unsafe_code = "deny"` without libc. They are pinned against the
    /// generated shell instead. Every branch that needs no such fixture is
    /// pinned here, the probe's "gone between the row and the probe" exit
    /// included.
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_row_classification_follows_the_session_liveness_rule() {
        // One past the kernel's maximum can never name a process, so `ps -L`
        // answers for it with the same exit 1 it gives a process that ended
        // between the row and the probe.
        let unassignable_pid = std::fs::read_to_string("/proc/sys/kernel/pid_max")
            .ok()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .map_or(u32::MAX, |pid_max| pid_max.saturating_add(1));
        // This very process: running, so `ps -L` lists a task that is not `Z`.
        let live_pid = std::process::id();

        assert_eq!(row_is_exited_process(live_pid, "S", Some("1")), Some(false));
        assert_eq!(
            row_is_exited_process(live_pid, "Sl", Some("9")),
            Some(false)
        );
        assert_eq!(
            row_is_exited_process(live_pid, "R+", Some("1")),
            Some(false)
        );
        // A single unreleased task needs no probe: nothing else to ask about.
        assert_eq!(row_is_exited_process(live_pid, "Z", Some("1")), Some(true));
        assert_eq!(row_is_exited_process(live_pid, "Zl", Some("1")), Some(true));
        // More than one does, and the probe — not the count — decides.
        assert_eq!(
            row_is_exited_process(live_pid, "Zl", Some("2")),
            Some(false)
        );
        assert_eq!(
            row_is_exited_process(unassignable_pid, "Zl", Some("2")),
            Some(true)
        );
        // A row that promised the count but did not carry a readable one is
        // indeterminate whatever its state.
        assert_eq!(row_is_exited_process(live_pid, "Z", None), None);
        assert_eq!(row_is_exited_process(live_pid, "S", Some("")), None);
        assert_eq!(row_is_exited_process(live_pid, "S", Some("two")), None);

        assert_eq!(every_task_exited(live_pid), Some(false));
        assert_eq!(every_task_exited(unassignable_pid), Some(true));
    }

    /// `ps -o tty=` has two spellings for "no controlling terminal", and both
    /// must be refused before they reach `ps -t`. Linux's `?` is the dangerous
    /// one: `ps -t '?'` exits 0 listing every process on the machine that has
    /// no tty, so accepting it would turn one session's teardown into a
    /// machine-wide kill. It is exactly what `ps -o tty=` reports for every
    /// member of a session whose PTY master just closed.
    #[test]
    fn no_controlling_terminal_is_never_an_enumerable_tty() {
        assert!(!is_enumerable_terminal("?"), "Linux's no-tty spelling");
        assert!(!is_enumerable_terminal("??"), "BSD's no-tty spelling");
        assert!(!is_enumerable_terminal(""), "an absent tty");
        assert!(is_enumerable_terminal("pts/3"));
        assert!(is_enumerable_terminal("ttys002"));
        assert!(is_enumerable_terminal("/dev/pts/3"));
    }

    /// Signalling group 0 must be refused, not enumerated. procps expands
    /// `pgrep -g 0` to the caller's own process group, so on Linux the old
    /// code path would have signalled every sibling of the running test —
    /// the runner agent included. This test is safe precisely because the
    /// guard returns before any `pgrep`/`kill` runs; without it, running this
    /// on Linux would kill the test process's own group.
    #[test]
    fn signalling_process_group_zero_is_refused() {
        assert!(!signal_non_anchor_members(0, 0, Signal::Term));
        assert!(!signal_non_anchor_members(0, 12345, Signal::Kill));
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
