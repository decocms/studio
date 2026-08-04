//! `GET /_sandbox/decofile` — the working-tree DRAFT decofile, every
//! `.deco/blocks/*.json` merged, served content-addressed for Fast Preview.
//!
//! Byte-parity target: `packages/sandbox/daemon-go/internal/routes/decofile.go`.
//! Unlike the daemon (where the fetcher is an arbitrary production server
//! with no way to carry the daemon bearer token), this route sits BEHIND the
//! `/_sandbox` guard — see `routes/events.rs`'s module doc for why this
//! crate tightens the daemon's no-auth posture for local-api. Loopback here
//! isn't reachable from the public internet, so byte-parity with the
//! daemon's unauthenticated route would only add an unused attack surface.
//!
//! Scoped to the process-global `state.repo_dir`/`state.config`/
//! `state.broadcaster` — exactly like `routes/fs.rs`'s write/read/etc, the
//! only handlers that ever mutate `.deco/blocks`. The merge here MUST
//! resolve the same tree those write through, or its version (and the SSE
//! `decofile` event's version) could drift from what was actually saved.
//! Deliberately NOT resolved via `AppState::resolve_sandbox_target` — that
//! per-handle resolution exists for `routes/events.rs`'s multi-sandbox
//! observability and would silently disagree with `fs.rs` whenever an
//! "active" sandbox happens to be set.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use tokio::sync::Mutex as AsyncMutex;

use crate::config::{get_str, ConfigStore};
use crate::error::ApiError;
use crate::events::Broadcaster;
use crate::state::AppState;

use super::fs::generate_decofile_from_blocks;

/// Resolves `.deco/blocks` under the configured package-manager path (repo
/// root when unset or relative-joined against `repo_dir`) — byte-parity with
/// the daemon's `paths.ResolvePmRoot` semantics.
fn blocks_dir(repo_dir: &Path, config: &ConfigStore) -> PathBuf {
    let snapshot = config.snapshot();
    let pm_path = snapshot
        .config
        .as_ref()
        .and_then(|c| get_str(c, &["application", "packageManager", "path"]))
        .filter(|p| !p.is_empty());
    let root = match pm_path {
        Some(p) if Path::new(p).is_absolute() => PathBuf::from(p),
        Some(p) => repo_dir.join(p),
        None => repo_dir.to_path_buf(),
    };
    root.join(".deco").join("blocks")
}

/// Per-`blocksDir` in-flight merge guards, so concurrent callers (a
/// connecting SSE client racing a `GET /decofile`, or two tabs) coalesce
/// onto one multi-MB merge instead of each redoing it. Never held across
/// anything but the merge itself.
fn coalescers() -> &'static Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>> {
    static CELL: OnceLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Merges the working tree's blocks and derives a version — the single
/// definition of "what version is the draft", shared by the ETag this route
/// serves and the `decofile` SSE event `routes/fs.rs`'s mutation handlers
/// announce, so a consumer's cache key and the announced pointer can never
/// disagree. `None` when there's no blocks dir to merge.
///
/// The version is a fast, non-cryptographic hash over the merged bytes (a
/// change detector, not a security boundary) — `DefaultHasher` uses fixed
/// keys, so it's deterministic across calls and process restarts.
pub(crate) async fn read_decofile(
    repo_dir: &Path,
    config: &ConfigStore,
) -> Option<(String, String)> {
    let dir = blocks_dir(repo_dir, config);
    let lock = {
        let mut table = coalescers().lock().unwrap();
        table
            .entry(dir.clone())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    let _guard = lock.lock().await;
    let text = generate_decofile_from_blocks(&dir).await?;
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    Some((text.clone(), format!("{:x}", hasher.finish())))
}

/// `.deco/blocks/*.json` — the paths whose write/edit/unlink/mkdir/rename
/// should trigger a `decofile` re-announce. Case-insensitive (a
/// case-insensitive filesystem can produce `.deco/blocks/x.JSON`), and
/// normalizes `\` so a Windows-style relative path still matches.
fn is_block_path(relative: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    normalized.contains(".deco/blocks/") && normalized.ends_with(".json")
}

/// Recomputes the merged blocks' version and, if it changed, broadcasts a
/// `decofile` event. Called (fire-and-forget) from every `routes::fs`
/// mutation handler after its own `"file-changed"` emit, filtered to paths
/// under `.deco/blocks` — mirrors the daemon's `announceDecofileVersion`,
/// including the unchanged-hash guard so a burst of unrelated saves can't
/// spam the same version.
pub(crate) fn maybe_announce(state: &AppState, relative_path: &str) {
    if !is_block_path(relative_path) {
        return;
    }
    spawn_announce(
        state.repo_dir.clone(),
        state.config.clone(),
        state.broadcaster.clone(),
    );
}

/// Unconditional counterpart to [`maybe_announce`] — called once the
/// clone/checkout step hands off to install (see `setup::install::run`'s
/// call site), so the initial draft version is published as soon as a
/// checked-out tree exists. A clone doesn't write through `routes::fs`, so
/// without this a fresh repo with no `.deco/blocks` WRITE ever observed
/// would never get an initial `decofile` announce — including, notably, a
/// decofile-only repo with no package manager configured at all, which
/// short-circuits before `setup::install` even reaches its own
/// `"installing"` lifecycle transition.
pub(crate) fn announce_working_tree_ready(
    repo_dir: PathBuf,
    config: Arc<ConfigStore>,
    broadcaster: Arc<Broadcaster>,
) {
    spawn_announce(repo_dir, config, broadcaster);
}

fn spawn_announce(repo_dir: PathBuf, config: Arc<ConfigStore>, broadcaster: Arc<Broadcaster>) {
    tokio::spawn(async move {
        announce(&repo_dir, &config, &broadcaster).await;
    });
}

/// Last version announced per `blocksDir`, so a burst of writes across
/// unrelated blocks doesn't re-broadcast an unchanged merge.
fn last_versions() -> &'static Mutex<HashMap<PathBuf, String>> {
    static CELL: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn announce(repo_dir: &Path, config: &ConfigStore, broadcaster: &Broadcaster) {
    let Some((_, version)) = read_decofile(repo_dir, config).await else {
        return;
    };
    let dir = blocks_dir(repo_dir, config);
    {
        let mut table = last_versions().lock().unwrap();
        if table.get(&dir) == Some(&version) {
            return;
        }
        table.insert(dir, version.clone());
    }
    broadcaster.emit("decofile", serde_json::json!({ "version": version }));
}

pub async fn decofile(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some((text, version)) = read_decofile(&state.repo_dir, &state.config).await else {
        return ApiError::not_found("No .deco/blocks to serve.").into_response();
    };

    let etag = format!("W/\"{version}\"");
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, &etag)
            .body(axum::body::Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::ETAG, &etag)
        // The draft changes on every save; never let a shared cache hold it.
        // Callers key their own cache on the ETag instead.
        .header(header::CACHE_CONTROL, "no-store")
        .body(axum::body::Body::from(text))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ConfigStore;
    use crate::tasks::TaskRegistry;
    use serde_json::json;

    /// Minimal `AppState` for a handler test — mirrors the same-shaped
    /// helper other route test modules each carry their own copy of (e.g.
    /// `routes/repo_dir.rs`), pointed at a caller-supplied `repo_dir` so it
    /// can be a fresh tempdir per test.
    fn fresh_state(repo_dir: std::path::PathBuf) -> AppState {
        let config = Arc::new(ConfigStore::new());
        let app_root = std::env::temp_dir();
        let logs = Arc::new(crate::log_store::LogStore::new(app_root.join("logs")));
        let tasks = Arc::new(TaskRegistry::new(logs));
        let broadcaster = Arc::new(Broadcaster::new());
        let setup = crate::setup::SetupOrchestrator::new(
            repo_dir.clone(),
            repo_dir.clone(),
            config.clone(),
            tasks.clone(),
            broadcaster.clone(),
        );
        AppState {
            update: None,
            token: "test-token".into(),
            boot_id: "test-boot".into(),
            sandbox_manager: crate::sandbox::SandboxManager::new(app_root.clone()),
            agent_sessions: crate::terminal::AgentSessionRegistry::new(),
            app_root,
            repo_dir,
            mode: crate::state::ApiMode::Strict,
            config,
            tasks,
            broadcaster,
            shutdown: Arc::new(crate::shutdown::ShutdownCoordinator::new()),
            setup,
        }
    }

    fn write_block(dir: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(format!("{name}.json")), body).unwrap();
    }

    #[test]
    fn is_block_path_matches_only_deco_blocks_json() {
        assert!(is_block_path(".deco/blocks/pages-home.json"));
        assert!(is_block_path(".deco/blocks/Header.JSON"));
        assert!(is_block_path(".deco\\blocks\\pages-home.json"));
        assert!(!is_block_path(".deco/blocks.gen.json"));
        assert!(!is_block_path("src/index.ts"));
        assert!(!is_block_path(".deco/blocks/pages-home.txt"));
    }

    #[tokio::test]
    async fn read_decofile_returns_none_with_no_blocks_dir() {
        let root = tempfile::tempdir().unwrap();
        let config = ConfigStore::new();
        assert!(read_decofile(root.path(), &config).await.is_none());
    }

    #[tokio::test]
    async fn read_decofile_produces_a_stable_version_that_changes_with_content() {
        let root = tempfile::tempdir().unwrap();
        let blocks = root.path().join(".deco").join("blocks");
        write_block(&blocks, "pages-home", r#"{"path":"/"}"#);
        let config = ConfigStore::new();

        let (text1, v1) = read_decofile(root.path(), &config).await.unwrap();
        assert!(text1.contains("pages-home"));
        let (_, v2) = read_decofile(root.path(), &config).await.unwrap();
        assert_eq!(v1, v2, "unchanged content must hash to the same version");

        write_block(&blocks, "pages-home", r#"{"path":"/","x":1}"#);
        let (_, v3) = read_decofile(root.path(), &config).await.unwrap();
        assert_ne!(v1, v3, "changed content must change the version");
    }

    #[tokio::test]
    async fn read_decofile_respects_package_manager_path() {
        let root = tempfile::tempdir().unwrap();
        let blocks = root
            .path()
            .join("apps")
            .join("web")
            .join(".deco")
            .join("blocks");
        write_block(&blocks, "pages-home", r#"{"path":"/"}"#);

        let config = ConfigStore::new();
        config
            .patch(json!({ "application": { "packageManager": { "path": "apps/web" } } }))
            .expect("patch applies");

        let (text, _) = read_decofile(root.path(), &config).await.unwrap();
        assert!(text.contains("pages-home"));
    }

    #[tokio::test]
    async fn decofile_handler_returns_404_with_no_blocks() {
        let root = tempfile::tempdir().unwrap();
        let response = super::decofile(
            State(fresh_state(root.path().to_path_buf())),
            HeaderMap::new(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn decofile_handler_serves_etag_and_revalidates() {
        let root = tempfile::tempdir().unwrap();
        write_block(
            &root.path().join(".deco").join("blocks"),
            "pages-home",
            r#"{"path":"/"}"#,
        );
        let state = fresh_state(root.path().to_path_buf());

        let response = super::decofile(State(state.clone()), HeaderMap::new()).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let etag = response
            .headers()
            .get(header::ETAG)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let mut matching = HeaderMap::new();
        matching.insert(header::IF_NONE_MATCH, etag.parse().unwrap());
        let revalidated = super::decofile(State(state.clone()), matching).await;
        assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);

        let mut stale = HeaderMap::new();
        stale.insert(header::IF_NONE_MATCH, "W/\"deadbeef\"".parse().unwrap());
        let full = super::decofile(State(state), stale).await;
        assert_eq!(full.status(), StatusCode::OK);
    }
}
