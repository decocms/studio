//! `GET /_sandbox/events` — SSE. Byte-parity target:
//! `daemon/routes/events-stream.ts` + `daemon/events/sse.ts`, oracle
//! `daemon.e2e.test.ts` (SSE smoke) + `daemon.sse-shapes.e2e.test.ts`
//! (per-event-type wire assertions) + `apps/native/e2e/sse.e2e.test.ts`.
//!
//! Frame format: `event: <name>\ndata: <json>\n\n`
//! (the native local-API contract). Headers:
//! `Content-Type: text/event-stream`, `Cache-Control: no-cache`,
//! `Connection: keep-alive`, `X-Accel-Buffering: no`,
//! `Content-Encoding: identity`.
//!
//! Unlike the daemon, this route sits BEHIND the `/_sandbox` guard (bearer +
//! Origin allowlist, wired in `router.rs`) — the contract doc deliberately
//! tightens the daemon's no-auth `/_sandbox/events` for local-api (see
//! the native local-API contract); no auth handling lives in
//! this file itself.
//!
//! ## Ownership boundary vs. the native module-ownership contract
//!
//! The `events` family here is scoped to the SSE hub itself: subscribing to
//! `state.broadcaster`, connect-time framing/headers, and the content of the
//! `status` snapshot frame. `"file-changed"`/`"reload"` emission is
//! explicitly assigned to the **fs**/**setup** families in
//! the native module-ownership contract's "Emits" table — this file does not run a
//! filesystem watcher and does not call `broadcaster.emit()` for those names
//! itself. Whatever any family `emit()`s is forwarded here verbatim by name.
//!
//! `"lifecycle"`, `"branch"`, and `"scripts"` connect-time snapshot frames
//! ARE sent (a Phase-1-doc correction: `crate::setup::SetupOrchestrator`
//! carries the real pipeline lifecycle/discovered-scripts state). Branch
//! metadata is recomputed from the resolved target's repository for every
//! handshake/sandbox switch. It must not come from process-global state:
//! several sandbox branches coexist in one app process and their worktrees
//! survive a backend restart. `"branch"`/`"scripts"` are conditionally
//! omitted exactly like the daemon's own `sse.ts` ("if (scripts) ...", "if
//! (branch) ...") when the resolved target has no repository/scripts.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::stream;
use serde::Deserialize;
use tokio::sync::{broadcast, mpsc};
use tokio::time::interval;

use crate::events::snapshot;
use crate::state::AppState;
use crate::tasks::TaskStatus;

/// Optional `?handle=<sandbox-handle>` — routes the SSE stream at a SPECIFIC
/// per-handle sandbox's orchestrator quadruple instead of the active/global
/// one. The query is used because a native `EventSource` (which some frontends
/// use) can't set the `x-decocms-sandbox-handle` header. A known durable handle
/// is metadata-adopted without starting processes, so retained logs can replay
/// immediately after a backend restart; an unknown explicit handle is a
/// truthful 404 and never falls through to global. An absent/empty handle
/// resolves active -> global through [`AppState::resolve_sandbox_target`].
/// `serde` ignores any other query params (e.g. a cache-buster).
#[derive(Deserialize)]
pub struct EventsQuery {
    pub(crate) handle: Option<String>,
}

/// Byte-parity value with `MAX_SSE_CLIENTS` (`daemon/constants.ts`). Not
/// pinned by either e2e suite for local-api, but cheap to carry forward so a
/// runaway reconnect loop can't unbounded-grow the broadcaster's client set.
const MAX_SSE_CLIENTS: usize = 100;

/// Byte-parity with `HEARTBEAT_INTERVAL_MS` (`daemon/events/sse.ts`).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);

/// Generous enough that a burst of connect-time snapshot frames plus a live
/// event never blocks the forwarding task on a slow consumer for long; the
/// consumer draining this channel is the HTTP response body writer.
const OUT_CHANNEL_CAPACITY: usize = 64;

/// Connect-time (and active-switch-time) frame set for a resolved target:
/// lifecycle/tasks/status/branch/scripts snapshots plus one `log` replay
/// frame per known source — see the inline comments, which moved here
/// verbatim when headerless streams learned to FOLLOW the active sandbox
/// (the same frames are now also emitted mid-stream on every switch).
async fn initial_frames(target: &crate::sandbox::SandboxTarget) -> Vec<Bytes> {
    let running = target.tasks.list(Some(&[TaskStatus::Running]));
    let mut initial = vec![
        snapshot::frame(
            "lifecycle",
            &snapshot::lifecycle(target.setup.lifecycle_snapshot()),
        ),
        snapshot::frame("tasks", &snapshot::active_tasks(&running)),
        snapshot::frame("status", &snapshot::status()),
    ];
    if let Some(meta) = crate::routes::git::branch_snapshot(&target.repo_dir).await {
        initial.push(snapshot::frame(
            "branch",
            &serde_json::json!({ "meta": meta }),
        ));
    }
    if let Some(scripts) = target.setup.discovered_scripts() {
        initial.push(snapshot::frame(
            "scripts",
            &serde_json::json!({ "scripts": scripts }),
        ));
    }

    // Replay each known log SOURCE's combined transcript as ONE `log` frame.
    // The broadcaster is LIVE-only (no per-subscriber backlog), and a
    // terminal almost always opens AFTER the dev server already printed its
    // startup output — so without this replay the pane is blank (a settled
    // dev server emits no new live lines).
    //
    // Sources are enumerated from `LogStore`'s stable `"app/<source>"` files,
    // NOT from `TaskRegistry`: after a backend restart the files survive but
    // the task registry is intentionally empty. The on-disk catalog therefore
    // makes old setup/dev output discoverable without restoring a RAM replay
    // buffer. `data`-only frames match exactly what live append emits, so the
    // frontend appends replay and live chunks identically.
    let logs = target.tasks.logs();
    for source in logs.app_sources().await {
        let data = logs
            .tail_read(
                &crate::log_store::app_key(&source),
                crate::log_store::DEFAULT_TAIL_BYTES,
            )
            .await;
        if !data.is_empty() {
            initial.push(snapshot::frame(
                "log",
                &serde_json::json!({ "source": source, "data": data }),
            ));
        }
    }

    initial
}

pub async fn events(State(state): State<AppState>, Query(q): Query<EventsQuery>) -> Response {
    // Resolve WHICH orchestrator quadruple this stream observes: a strict,
    // metadata-only-adopted per-handle sandbox (`?handle=`), the active sandbox
    // (headerless), or the process-global one. Every per-target read below
    // (`broadcaster`, `tasks`, `setup`, `repo_dir`) uses this, including the
    // connect-time branch snapshot.
    let explicit_handle = q.handle.filter(|handle| !handle.is_empty());
    let target = match explicit_handle.as_deref() {
        Some(handle) => match state.sandbox_manager.adopt(handle).await {
            Ok(Some(sandbox)) => crate::sandbox::SandboxTarget::from_sandbox(&sandbox),
            Ok(None) => {
                return (
                    StatusCode::NOT_FOUND,
                    format!("unknown sandbox handle: {handle}"),
                )
                    .into_response();
            }
            Err(error) => {
                tracing::error!(handle, %error, "failed to adopt sandbox for event replay");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "failed to resolve sandbox event stream",
                )
                    .into_response();
            }
        },
        None => state.resolve_sandbox_target(None),
    };

    if target.broadcaster.subscriber_count() >= MAX_SSE_CLIENTS {
        return (StatusCode::TOO_MANY_REQUESTS, "Too many connections").into_response();
    }

    // Subscribe BEFORE building the connect-time snapshot so a live event
    // emitted while the snapshot is being assembled is never lost (a small
    // improvement over the daemon's own `sse.ts`, which registers its
    // controller only after enqueuing every snapshot frame — harmless either
    // way since no oracle test pins exact frame ordering/count here, but
    // strictly safer).
    let mut rx = target.broadcaster.subscribe();
    // Headerless streams follow the active sandbox. Explicit streams follow
    // one durable handle's process generations, so Stop -> Resume remains
    // observable even if another chat becomes active in between.
    let mut active_rx = state.sandbox_manager.watch_active();
    let mut generation_rx = match explicit_handle.as_deref() {
        Some(handle) => state.sandbox_manager.watch_generation(handle),
        None => tokio::sync::watch::channel(None).1,
    };

    let initial = initial_frames(&target).await;

    let (tx, out_rx) = mpsc::channel::<Bytes>(OUT_CHANNEL_CAPACITY);

    // The heartbeat re-reads the CURRENT resolved target's lifecycle, so move
    // its `setup` Arc into the forwarding task (re-assigned on active-switch).
    let mut heartbeat_setup = target.setup.clone();
    let mut current_broadcaster = target.broadcaster.clone();
    let task_state = state.clone();
    tokio::spawn(async move {
        for frame in initial {
            if tx.send(frame).await.is_err() {
                return;
            }
        }

        let mut heartbeat = interval(HEARTBEAT_INTERVAL);
        heartbeat.tick().await; // first tick fires immediately — consume it

        loop {
            tokio::select! {
                event = rx.recv() => {
                    match event {
                        Ok(ev) => {
                            let frame = snapshot::frame(&ev.name, &ev.data);
                            if tx.send(frame).await.is_err() {
                                return;
                            }
                        }
                        // A slow consumer fell behind the broadcast channel's
                        // ring buffer — per `events/broadcaster.rs`'s module
                        // doc, resync by continuing to read forward rather
                        // than treating this as a fatal stream error.
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
                _ = heartbeat.tick() => {
                    let frame = snapshot::frame(
                        "lifecycle",
                        &snapshot::lifecycle(heartbeat_setup.lifecycle_snapshot()),
                    );
                    if tx.send(frame).await.is_err() {
                        return;
                    }
                }
                changed = active_rx.changed(), if explicit_handle.is_none() => {
                    if changed.is_err() {
                        // Manager dropped (shutdown) — keep serving the
                        // current subscription until the client goes away.
                        continue;
                    }
                    let now_active = active_rx.borrow_and_update().clone();
                    let new_target = task_state.resolve_sandbox_target(now_active.as_deref());
                    if std::sync::Arc::ptr_eq(&new_target.broadcaster, &current_broadcaster) {
                        continue;
                    }
                    current_broadcaster = new_target.broadcaster.clone();
                    rx = new_target.broadcaster.subscribe();
                    heartbeat_setup = new_target.setup.clone();
                    for frame in initial_frames(&new_target).await {
                        if tx.send(frame).await.is_err() {
                            return;
                        }
                    }
                }
                changed = generation_rx.changed(), if explicit_handle.is_some() => {
                    if changed.is_err() {
                        continue;
                    }
                    let Some(sandbox) = generation_rx.borrow_and_update().clone() else {
                        // Stop publishes `None`. Keep the old subscription long
                        // enough to deliver its final idle snapshot; Resume will
                        // publish the replacement Arc on this same watch.
                        continue;
                    };
                    let new_target = crate::sandbox::SandboxTarget::from_sandbox(&sandbox);
                    if std::sync::Arc::ptr_eq(&new_target.broadcaster, &current_broadcaster) {
                        continue;
                    }
                    current_broadcaster = new_target.broadcaster.clone();
                    rx = new_target.broadcaster.subscribe();
                    heartbeat_setup = new_target.setup.clone();
                    for frame in initial_frames(&new_target).await {
                        if tx.send(frame).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    });

    let body_stream = stream::unfold(out_rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|frame| (Ok::<_, Infallible>(frame), rx))
    });

    match Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .header("X-Accel-Buffering", "no")
        .header(header::CONTENT_ENCODING, "identity")
        .body(Body::from_stream(body_stream))
    {
        Ok(res) => res,
        Err(err) => {
            tracing::error!(%err, "failed to build SSE response");
            crate::error::ApiError::internal("failed to build SSE response").into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use std::path::Path;
    use std::process::Command;
    use std::sync::Arc;

    fn git(dir: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git failed to spawn");
        assert!(
            output.status.success(),
            "git {args:?} failed in {dir:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(dir: &Path, branch: &str) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", branch]);
        git(dir, &["config", "user.name", "Test User"]);
        git(dir, &["config", "user.email", "test@example.com"]);
        std::fs::write(dir.join("README.md"), format!("{branch}\n")).unwrap();
        git(dir, &["add", "."]);
        git(dir, &["commit", "-q", "-m", "initial"]);
    }

    fn target_for_repo(root: &Path, repo_dir: &Path, name: &str) -> crate::sandbox::SandboxTarget {
        let logs = Arc::new(crate::log_store::LogStore::new(
            root.join(format!("{name}-logs")),
        ));
        let tasks = Arc::new(crate::tasks::TaskRegistry::new(logs));
        let config = Arc::new(crate::config::ConfigStore::new());
        let broadcaster = Arc::new(crate::events::Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.to_path_buf(),
            repo_dir.to_path_buf(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        crate::sandbox::SandboxTarget {
            setup,
            tasks,
            broadcaster,
            config,
            repo_dir: repo_dir.to_path_buf(),
        }
    }

    async fn branch_frame(target: &crate::sandbox::SandboxTarget) -> String {
        initial_frames(target)
            .await
            .into_iter()
            .map(|frame| String::from_utf8(frame.to_vec()).unwrap())
            .find(|frame| frame.starts_with("event: branch\n"))
            .expect("resolved repository has a branch snapshot")
    }

    fn state_with_manager(
        app_root: &std::path::Path,
        manager: Arc<crate::sandbox::SandboxManager>,
    ) -> AppState {
        let repo_dir = app_root.join("global-repo");
        let logs = Arc::new(crate::log_store::LogStore::new(
            app_root.join("global-logs"),
        ));
        let tasks = Arc::new(crate::tasks::TaskRegistry::new(logs));
        let config = Arc::new(crate::config::ConfigStore::new());
        let broadcaster = Arc::new(crate::events::Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        AppState {
            token: "test-token".into(),
            boot_id: "test-boot".into(),
            app_root: app_root.to_path_buf(),
            repo_dir,
            mode: crate::state::ApiMode::Strict,
            config,
            tasks,
            broadcaster,
            shutdown: Arc::new(crate::shutdown::ShutdownCoordinator::new()),
            setup,
            sandbox_manager: manager,
        }
    }

    #[tokio::test]
    async fn initial_frames_replay_preexisting_files_with_an_empty_task_registry() {
        let dir = tempfile::tempdir().unwrap();
        let repo_dir = dir.path().join("repo");
        let logs_root = dir.path().join("logs");
        tokio::fs::create_dir_all(logs_root.join("app"))
            .await
            .unwrap();
        tokio::fs::write(logs_root.join("app/setup"), "clone then install\n")
            .await
            .unwrap();
        tokio::fs::write(logs_root.join("app/dev"), "server ready\n")
            .await
            .unwrap();

        let logs = Arc::new(crate::log_store::LogStore::new(logs_root));
        let tasks = Arc::new(crate::tasks::TaskRegistry::new(logs));
        assert!(tasks.list(None).is_empty(), "fixture models a fresh boot");
        let config = Arc::new(crate::config::ConfigStore::new());
        let broadcaster = Arc::new(crate::events::Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        let target = crate::sandbox::SandboxTarget {
            setup,
            tasks,
            broadcaster,
            config,
            repo_dir,
        };

        let replay: Vec<String> = initial_frames(&target)
            .await
            .into_iter()
            .map(|frame| String::from_utf8(frame.to_vec()).unwrap())
            .filter(|frame| frame.starts_with("event: log\n"))
            .collect();

        assert_eq!(replay.len(), 2);
        assert!(replay[0].contains(r#""source":"dev""#));
        assert!(replay[0].contains(r#""data":"server ready\n""#));
        assert!(replay[1].contains(r#""source":"setup""#));
        assert!(replay[1].contains(r#""data":"clone then install\n""#));
    }

    #[tokio::test]
    async fn explicit_stream_adopts_durable_metadata_and_replays_without_starting() {
        let root = tempfile::tempdir().unwrap();
        let config = crate::sandbox::GitSandboxConfig {
            virtual_mcp_id: "vmcp-replay-after-restart".to_string(),
            clone_url: "https://example.invalid/repo.git".to_string(),
            branch: Some("feature/replay".to_string()),
            ..Default::default()
        };
        let handle = crate::sandbox::SandboxManager::compute_handle(
            &config.virtual_mcp_id,
            config.branch.as_deref().unwrap(),
        );
        let sandbox_root = root.path().join("sandboxes").join(&handle);
        init_repo(&sandbox_root.join("repo"), "feature/replay");
        tokio::fs::create_dir_all(sandbox_root.join("logs/app"))
            .await
            .unwrap();
        tokio::fs::write(
            sandbox_root.join("logs/app/setup"),
            "retained before restart\n",
        )
        .await
        .unwrap();
        crate::sandbox::persist::write_sidecar(root.path(), &handle, &config);

        // Opening a fresh manager imports the legacy sidecar into SQLite but
        // deliberately leaves its live object cache empty.
        let manager = crate::sandbox::SandboxManager::new(root.path().to_path_buf());
        assert!(manager.get(&handle).is_none());
        let state = state_with_manager(root.path(), manager.clone());

        let response = events(
            State(state),
            Query(EventsQuery {
                handle: Some(handle.clone()),
            }),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let adopted = manager.get(&handle).expect("metadata was adopted");
        assert!(
            adopted.tasks.list(None).is_empty(),
            "observing retained logs must not spawn setup/dev tasks"
        );

        let mut body = response.into_body().into_data_stream();
        let (branch, replay) = tokio::time::timeout(Duration::from_secs(1), async {
            let mut branch = None;
            let mut replay = None;
            loop {
                let chunk = body
                    .next()
                    .await
                    .expect("SSE remains open")
                    .expect("SSE body chunk");
                let frame = String::from_utf8(chunk.to_vec()).unwrap();
                if frame.starts_with("event: branch\n") {
                    branch = Some(frame);
                } else if frame.starts_with("event: log\n") {
                    replay = Some(frame);
                }
                if let (Some(branch), Some(replay)) = (branch.clone(), replay.clone()) {
                    break (branch, replay);
                }
            }
        })
        .await
        .expect("branch and retained log replay arrived");
        assert!(branch.contains(r#""branch":"feature/replay""#));
        assert!(replay.contains(r#""source":"setup""#));
        assert!(replay.contains(r#""data":"retained before restart\n""#));
    }

    #[tokio::test]
    async fn initial_branch_snapshot_is_scoped_to_each_resolved_target() {
        let root = tempfile::tempdir().unwrap();
        let main_repo = root.path().join("main-repo");
        let feature_repo = root.path().join("feature-repo");
        init_repo(&main_repo, "main");
        init_repo(&feature_repo, "feature/two");

        let main = target_for_repo(root.path(), &main_repo, "main");
        let feature = target_for_repo(root.path(), &feature_repo, "feature");

        let main_frame = branch_frame(&main).await;
        let feature_frame = branch_frame(&feature).await;
        assert!(main_frame.contains(r#""branch":"main""#));
        assert!(!main_frame.contains(r#""branch":"feature/two""#));
        assert!(feature_frame.contains(r#""branch":"feature/two""#));
        assert!(!feature_frame.contains(r#""branch":"main""#));
    }
}
