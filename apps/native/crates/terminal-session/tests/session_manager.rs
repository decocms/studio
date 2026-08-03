use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use bytes::Bytes;
use tempfile::TempDir;
use terminal_session::{
    CommandSpec, ManagerConfig, SessionEvent, SessionKey, TerminalError, TerminalSessionManager,
    TerminalSize, TerminationPolicy,
};

fn key(name: &str) -> SessionKey {
    SessionKey::new("account", "organization", name, "generation-1")
        .expect("test session key must be valid")
}

fn write_fixture(directory: &TempDir, name: &str, source: &str) -> PathBuf {
    let path = directory.path().join(name);
    fs::write(&path, source).expect("fixture script must be writable");
    path
}

fn shell(script: &Path) -> CommandSpec {
    CommandSpec::new("/bin/sh").arg(script)
}

async fn collect_until(
    subscription: &mut terminal_session::TerminalSubscription,
    needle: &[u8],
) -> Vec<u8> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut output = Vec::new();
        loop {
            match subscription
                .recv()
                .await
                .expect("terminal subscription must stay open")
            {
                SessionEvent::Output(chunk) => {
                    output.extend_from_slice(&chunk.data);
                    if output.windows(needle.len()).any(|window| window == needle) {
                        return output;
                    }
                }
                SessionEvent::Exited(exit) => {
                    panic!("terminal exited before expected output: {exit:?}")
                }
                _ => {}
            }
        }
    })
    .await
    .expect("terminal output timed out")
}

fn quick_policy() -> TerminationPolicy {
    TerminationPolicy {
        term_grace: Duration::from_millis(150),
        kill_grace: Duration::from_secs(2),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_is_interactive_and_supports_input_ansi_and_resize() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "interactive.sh",
        r#"
stty -echo
on_winch() {
  dimensions=$(stty size)
  printf 'SIZE:%s\n' "$dimensions"
}
trap on_winch WINCH
if [ -t 0 ] && [ -t 1 ] && [ -t 2 ]; then
  printf 'READY:TTY:%s\n' "$(stty size)"
else
  printf 'READY:NOT_TTY\n'
fi
while IFS= read -r line; do
  if [ "$line" = "quit" ]; then
    exit 7
  fi
  printf '\033[31mECHO:%s\033[0m\n' "$line"
done
"#,
    );
    let manager = TerminalSessionManager::default();
    let started = manager
        .start_or_attach(
            key("interactive"),
            shell(&script),
            TerminalSize::new(24, 80),
        )
        .await
        .expect("terminal must start");
    assert!(started.created);
    let session = started.session;
    let mut subscription = session.subscribe(0);

    let ready = collect_until(&mut subscription, b"READY:TTY:24 80").await;
    assert!(!ready.windows(7).any(|window| window == b"NOT_TTY"));

    session
        .resize(TerminalSize::new(40, 100))
        .await
        .expect("resize must reach PTY");
    collect_until(&mut subscription, b"SIZE:40 100").await;

    session
        .write(Bytes::from_static(b"hello terminal\n"))
        .await
        .expect("input must reach PTY");
    let echoed = collect_until(&mut subscription, b"ECHO:hello terminal").await;
    assert!(echoed.windows(5).any(|window| window == b"\x1b[31m"));

    session
        .write(Bytes::from_static(b"quit\n"))
        .await
        .expect("quit input must reach PTY");
    let exit = tokio::time::timeout(Duration::from_secs(3), session.wait())
        .await
        .expect("shell must exit");
    assert_eq!(exit.code, 7);
    assert!(!exit.requested);
    assert!(exit.output_complete);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pty_child_disables_color_without_losing_tui_capabilities() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "no-color-environment.sh",
        r#"
stty -echo
printf 'COLOR_ENV:%s|%s|%s|%s|%s|%s\n' \
  "${NO_COLOR-unset}" \
  "${NODE_DISABLE_COLORS-unset}" \
  "${FORCE_COLOR-unset}" \
  "${CLICOLOR-unset}" \
  "${TERM-unset}" \
  "${COLORTERM-unset}"
while IFS= read -r line; do
  [ "$line" = "quit" ] && exit 0
done
"#,
    );
    let command = shell(&script)
        .env("NO_COLOR", "0")
        .env("NODE_DISABLE_COLORS", "0")
        .env("FORCE_COLOR", "1")
        .env("CLICOLOR", "1")
        .env("TERM", "dumb")
        .env("COLORTERM", "truecolor");
    let manager = TerminalSessionManager::default();
    let session = manager
        .start_or_attach(
            key("no-color-environment"),
            command,
            TerminalSize::default(),
        )
        .await
        .expect("terminal must start")
        .session;
    let mut subscription = session.subscribe(0);

    let expected = "COLOR_ENV:1|1|0|0|xterm-256color|unset";
    let output = collect_until(&mut subscription, expected.as_bytes()).await;
    assert!(
        String::from_utf8_lossy(&output).contains(expected),
        "PTY child did not receive the no-color terminal environment: {}",
        String::from_utf8_lossy(&output)
    );

    session
        .write(Bytes::from_static(b"quit\n"))
        .await
        .expect("quit input must reach PTY");
    assert!(session.wait().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_start_creates_exactly_one_process() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "waiting.sh",
        r#"
stty -echo
printf 'READY:%s\n' "$$"
while IFS= read -r line; do
  [ "$line" = "quit" ] && exit 0
done
"#,
    );
    let manager = TerminalSessionManager::default();
    let session_key = key("concurrent");
    let first =
        manager.start_or_attach(session_key.clone(), shell(&script), TerminalSize::default());
    let second =
        manager.start_or_attach(session_key.clone(), shell(&script), TerminalSize::default());
    let (first, second) = tokio::join!(first, second);
    let first = first.expect("first start");
    let second = second.expect("second start");

    assert_ne!(first.created, second.created);
    assert_eq!(first.session.id(), second.session.id());
    assert_eq!(first.session.pid(), second.session.pid());
    assert_eq!(manager.active_count(), 1);

    first
        .session
        .write(Bytes::from_static(b"quit\n"))
        .await
        .expect("quit input");
    let exit = first.session.wait().await;
    assert!(exit.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn completed_session_releases_its_key_before_wait_returns() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(&directory, "immediate.sh", "printf 'DONE\\n'\nexit 0\n");
    let manager = TerminalSessionManager::default();
    let session_key = key("restart");
    let first = manager
        .start_or_attach(session_key.clone(), shell(&script), TerminalSize::default())
        .await
        .expect("first terminal must start");
    assert!(first.session.wait().await.success());

    let second = manager
        .start_or_attach(session_key, shell(&script), TerminalSize::default())
        .await
        .expect("completed key must be reusable immediately");
    assert!(second.created);
    assert_ne!(first.session.id(), second.session.id());
    assert!(second.session.wait().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistence_owned_id_must_match_an_existing_slot() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "waiting.sh",
        "stty -echo\nprintf 'READY\\n'\nwhile IFS= read -r line; do :; done\n",
    );
    let manager = TerminalSessionManager::default();
    let session_key = key("persistent-id");
    let first = manager
        .start_or_attach_with_id(
            session_key.clone(),
            "database-session-id".to_string(),
            shell(&script),
            TerminalSize::default(),
        )
        .await
        .expect("terminal must start");
    assert_eq!(first.session.id(), "database-session-id");

    let conflict = manager
        .start_or_attach_with_id(
            session_key,
            "different-id".to_string(),
            shell(&script),
            TerminalSize::default(),
        )
        .await
        .expect_err("mismatched persistence id must fail");
    assert!(matches!(conflict, TerminalError::SessionIdConflict { .. }));

    first
        .session
        .terminate(quick_policy())
        .await
        .expect("terminal must terminate");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupt_targets_the_foreground_process_group() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "interrupt.sh",
        r#"
stty -echo
trap 'printf "INTERRUPTED\n"; exit 130' INT
printf 'READY\n'
while :; do sleep 1; done
"#,
    );
    let manager = TerminalSessionManager::default();
    let session = manager
        .start_or_attach(key("interrupt"), shell(&script), TerminalSize::default())
        .await
        .expect("terminal must start")
        .session;
    let mut subscription = session.subscribe(0);
    collect_until(&mut subscription, b"READY").await;

    session.interrupt().await.expect("SIGINT must be delivered");
    collect_until(&mut subscription, b"INTERRUPTED").await;
    let exit = session.wait().await;
    assert_eq!(exit.code, 130);
    assert!(!exit.requested);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn interrupt_does_not_signal_the_agent_group_behind_a_foreground_job() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "foreground-interrupt.sh",
        r#"
stty -echo
set -m
trap 'printf "PARENT_INTERRUPTED\n"; exit 91' INT
/bin/sh -c 'trap '\''printf "CHILD_INTERRUPTED\n"; exit 130'\'' INT; printf "CHILD_READY\n"; while :; do sleep 1; done'
status=$?
printf 'PARENT_SURVIVED:%s\n' "$status"
exit 0
"#,
    );
    let manager = TerminalSessionManager::default();
    let session = manager
        .start_or_attach(
            key("foreground-interrupt"),
            shell(&script),
            TerminalSize::default(),
        )
        .await
        .expect("terminal must start")
        .session;
    let mut subscription = session.subscribe(0);
    collect_until(&mut subscription, b"CHILD_READY").await;

    session.interrupt().await.expect("SIGINT must be delivered");
    let output = collect_until(&mut subscription, b"PARENT_SURVIVED").await;
    assert!(
        !output
            .windows(b"PARENT_INTERRUPTED".len())
            .any(|window| window == b"PARENT_INTERRUPTED"),
        "SIGINT reached the base agent process as well as its foreground job"
    );
    assert!(session.wait().await.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminate_escalates_when_sigterm_is_ignored() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "ignore-term.sh",
        r#"
stty -echo
trap '' TERM HUP
printf 'READY\n'
while :; do sleep 1; done
"#,
    );
    let manager = TerminalSessionManager::default();
    let session = manager
        .start_or_attach(key("escalate"), shell(&script), TerminalSize::default())
        .await
        .expect("terminal must start")
        .session;
    let mut subscription = session.subscribe(0);
    collect_until(&mut subscription, b"READY").await;

    let exit = session
        .terminate(quick_policy())
        .await
        .expect("SIGKILL escalation must reap terminal");
    assert!(exit.requested);
    assert!(!exit.success());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn direct_child_exit_kills_a_hup_ignoring_pty_descendant() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "orphan.sh",
        r#"
stty -echo
(
  trap '' HUP TERM
  while :; do sleep 1; done
) &
printf 'DESCENDANT:%s\n' "$!"
exit 0
"#,
    );
    let manager = TerminalSessionManager::new(ManagerConfig {
        output_drain_timeout: Duration::from_millis(100),
        ..ManagerConfig::default()
    });
    let session = manager
        .start_or_attach(
            key("orphan-cleanup"),
            shell(&script),
            TerminalSize::default(),
        )
        .await
        .expect("terminal must start")
        .session;
    let mut subscription = session.subscribe(0);
    let output = collect_until(&mut subscription, b"DESCENDANT:").await;
    let output = String::from_utf8_lossy(&output);
    let descendant_pid = output
        .split("DESCENDANT:")
        .nth(1)
        .and_then(|tail| tail.lines().next())
        .map(str::trim)
        .expect("fixture must print its descendant pid")
        .to_string();
    let exit = session.wait().await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    let mut descendant_alive = true;
    while descendant_alive && tokio::time::Instant::now() < deadline {
        descendant_alive = Command::new("/bin/kill")
            .args(["-0", &descendant_pid])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if descendant_alive {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
    let descendant_diagnostics = Command::new("/bin/ps")
        .args([
            "-o",
            "pid=,ppid=,pgid=,sess=,tsess=,tpgid=,tty=,stat=,command=",
            "-p",
            &descendant_pid,
        ])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
        .unwrap_or_else(|error| format!("ps failed: {error}"));
    if descendant_alive {
        let _ = Command::new("/bin/kill")
            .args(["-KILL", &descendant_pid])
            .status();
    }
    assert!(
        !descendant_alive,
        "PTY descendant survived its session: {descendant_diagnostics}"
    );
    assert!(
        exit.output_complete,
        "terminal reader did not drain: {exit:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn replay_is_byte_bounded_and_reports_a_precise_gap() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "replay.sh",
        "stty -echo\nprintf 'abcdefghijklmnopqrstuvwxyz'\nprintf 'READY\\n'\nwhile IFS= read -r line; do :; done\n",
    );
    let manager = TerminalSessionManager::new(ManagerConfig {
        replay_capacity_bytes: 16,
        broadcast_capacity: 2,
        ..ManagerConfig::default()
    });
    let session = manager
        .start_or_attach(key("replay"), shell(&script), TerminalSize::default())
        .await
        .expect("terminal must start")
        .session;

    tokio::time::timeout(Duration::from_secs(3), async {
        while session.replay_from(0).next_offset < 32 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("fixture output must arrive");

    let replay = session.replay_from(0);
    assert!(replay.truncated);
    assert_eq!(replay.next_offset - replay.available_from, 16);
    let mut subscription = session.subscribe(0);
    let first = subscription.recv().await.expect("gap event");
    assert!(matches!(
        first,
        SessionEvent::ReplayGap {
            requested: 0,
            available,
            next_offset,
        } if available == replay.available_from && next_offset == replay.next_offset
    ));

    session
        .terminate(quick_policy())
        .await
        .expect("terminal must terminate");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn manager_shutdown_closes_admission_and_reaps_every_session() {
    let directory = TempDir::new().expect("temp directory");
    let script = write_fixture(
        &directory,
        "waiting.sh",
        "stty -echo\nprintf 'READY\\n'\nwhile :; do sleep 1; done\n",
    );
    let manager = TerminalSessionManager::default();
    for name in ["shutdown-a", "shutdown-b"] {
        manager
            .start_or_attach(key(name), shell(&script), TerminalSize::default())
            .await
            .expect("terminal must start");
    }

    let report = manager.shutdown(quick_policy()).await;
    assert_eq!(report.requested, 2);
    assert!(
        report.all_stopped(),
        "shutdown failures: {:?}",
        report.failures
    );
    assert!(manager.is_shutting_down());

    let rejected = manager
        .start_or_attach(
            key("after-shutdown"),
            shell(&script),
            TerminalSize::default(),
        )
        .await
        .expect_err("shutdown manager must reject new sessions");
    assert_eq!(rejected, TerminalError::ManagerShuttingDown);
}
