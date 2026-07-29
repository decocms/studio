//! `/threads*` — new, no daemon precedent. Local-only SQLite store (no
//! upstream sync — the desktop migration contract decision #6). Full shape/route table:
//! the native local-API contract, oracle
//! `apps/native/e2e/threads.e2e.test.ts`.
//!
//! Implementer notes:
//! - Storage: `<state.app_root>/studio.db` (WAL-mode SQLite via the
//!   `rusqlite` dependency already in `Cargo.toml`). Distinct from a
//!   project's `.deco/tools/` catalog dir used by `fs::tools_sync` — do not
//!   collide the two directories.
//! - `Thread { id, title, created_at, updated_at }`,
//!   `Message { id, thread_id, role, parts: JSON array (opaque), created_at }`,
//!   `Run { id, thread_id, harness_id, status, created_at, ended_at, error }`
//!   — `Run.id` MUST equal the dispatch route's `runId` for the same turn.
//!   Phase 2 CORRECTION to an earlier Phase 1 doc pass: `routes/dispatch.rs`
//!   DOES write to this store as its SSE stream lands (see that file's
//!   module doc for why — unlike the TS daemon, local-api's dispatch route
//!   has no separate cluster-side consumer to hand the write off to; the
//!   desktop frontend IS the SSE consumer, so dispatch persists on its
//!   behalf). The write path uses [`ThreadsDb::create_message_with_id`] /
//!   [`ThreadsDb::create_run`] / [`ThreadsDb::set_run_terminal_status`]
//!   (idempotent-by-id variants) rather than this file's own
//!   `create_message`, so a dispatch retry/re-poll can never duplicate a
//!   thread's message history.
//! - `POST /threads` defaults `title` to `""` (never null) when the body
//!   omits it.
//! - `DELETE /threads/:id` is idempotent (204 even if already gone,
//!   matching the daemon's `unlink` idempotency precedent) and cascades to
//!   the thread's messages and runs.
//!
//! The SQLite layer lives in the `db` submodule (`routes/threads/db.rs`) —
//! pure CRUD against a `rusqlite::Connection`, unit-tested there against
//! `:memory:` without touching axum or the filesystem. This file is only
//! the HTTP <-> `ThreadsDb` translation: body parsing, 400/404 shaping,
//! lazy DB handle ([`shared_db`]).

/// `pub(crate)` (not module-private) so `routes::dispatch` — a SIBLING
/// module, Phase 2's dispatch route persisting run/message rows as a
/// stream lands (see that file's module doc) — can reach `ThreadsDb`,
/// `DbError`, and `DbResult` directly (`crate::routes::threads::db::*`)
/// without a second, independently-opened SQLite connection to the SAME
/// `studio.db` file.
pub(crate) mod db;

use std::sync::OnceLock;

use db::ThreadsDb;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// Lazily opened once per process. `AppState` is a shared file this family
/// may not add a field to (see the native module-ownership contract), so
/// the handle lives here instead — `state.app_root` (already on
/// `AppState`) is all `ThreadsDb::open` needs, and it never changes after
/// boot, so a process-lifetime `OnceLock` is equivalent to a field.
static DB: OnceLock<ThreadsDb> = OnceLock::new();

pub(crate) fn shared_db(state: &AppState) -> ApiResult<&'static ThreadsDb> {
    if let Some(db) = DB.get() {
        return Ok(db);
    }
    let opened = ThreadsDb::open(&state.app_root)
        .map_err(|e| ApiError::internal(format!("failed to open local thread database: {e}")))?;
    // Racing initializers (two concurrent first-requests) both succeed at
    // `open`; only one wins `set`, the loser's connection is simply
    // dropped. Harmless — SQLite tolerates multiple connections to the same
    // WAL-mode file.
    let _ = DB.set(opened);
    DB.get()
        .ok_or_else(|| ApiError::internal("thread database failed to initialize"))
}

/// `pub(crate)` (not just module-private) for the same reason as
/// `shared_db`/`ThreadsDb` above — `routes::dispatch` maps `DbError`s from
/// its own `ThreadsDb` calls through this exact helper so a storage
/// failure surfaces identically regardless of which route hit it.
pub(crate) fn db_err(e: db::DbError) -> ApiError {
    ApiError::internal(format!("thread database error: {e}"))
}

fn parse_body<T: serde::de::DeserializeOwned + Default>(bytes: &[u8]) -> ApiResult<T> {
    crate::http_util::json_body_or_default(bytes, "invalid JSON body")
}

fn thread_not_found() -> ApiError {
    ApiError::not_found("thread not found")
}

// --- GET /threads -------------------------------------------------------------

pub async fn list(State(state): State<AppState>) -> ApiResult<Json<Value>> {
    let db = shared_db(&state)?;
    let threads = db.list_threads().map_err(db_err)?;
    Ok(Json(json!({ "threads": threads })))
}

// --- POST /threads -------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
struct CreateThreadBody {
    #[serde(default)]
    title: Option<String>,
}

pub async fn create(State(state): State<AppState>, body: Bytes) -> ApiResult<Response> {
    let parsed: CreateThreadBody = parse_body(&body)?;
    let db = shared_db(&state)?;
    let thread = db
        .create_thread(parsed.title.unwrap_or_default())
        .map_err(db_err)?;
    Ok((StatusCode::CREATED, Json(json!({ "thread": thread }))).into_response())
}

// --- GET /threads/:id -----------------------------------------------------------

pub async fn get(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let db = shared_db(&state)?;
    let thread = db
        .get_thread(&id)
        .map_err(db_err)?
        .ok_or_else(thread_not_found)?;
    Ok(Json(json!({ "thread": thread })))
}

// --- PATCH /threads/:id ----------------------------------------------------------

#[derive(Deserialize, Default)]
struct UpdateThreadBody {
    title: Option<String>,
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let parsed: UpdateThreadBody = parse_body(&body)?;
    let title = parsed
        .title
        .ok_or_else(|| ApiError::bad_request("title is required"))?;
    let db = shared_db(&state)?;
    let thread = db
        .update_thread_title(&id, &title)
        .map_err(db_err)?
        .ok_or_else(thread_not_found)?;
    Ok(Json(json!({ "thread": thread })))
}

// --- DELETE /threads/:id ---------------------------------------------------------

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let db = shared_db(&state)?;
    db.delete_thread(&id).map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT)
}

// --- GET /threads/:id/messages ----------------------------------------------------

pub async fn messages_list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let db = shared_db(&state)?;
    if !db.thread_exists(&id).map_err(db_err)? {
        return Err(thread_not_found());
    }
    let messages = db.list_messages(&id).map_err(db_err)?;
    Ok(Json(json!({ "messages": messages })))
}

// --- POST /threads/:id/messages ---------------------------------------------------

#[derive(Deserialize, Default)]
struct CreateMessageBody {
    role: Option<String>,
    #[serde(default)]
    parts: Value,
}

fn is_valid_role(role: &str) -> bool {
    matches!(role, "user" | "assistant" | "system")
}

pub async fn messages_create(
    State(state): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let parsed: CreateMessageBody = parse_body(&body)?;
    let role = parsed.role.unwrap_or_default();
    if !is_valid_role(&role) {
        return Err(ApiError::bad_request(
            "role must be one of user, assistant, system",
        ));
    }
    let db = shared_db(&state)?;
    if !db.thread_exists(&id).map_err(db_err)? {
        return Err(thread_not_found());
    }
    let message = db
        .create_message(&id, &role, &parsed.parts)
        .map_err(db_err)?;
    Ok((StatusCode::CREATED, Json(json!({ "message": message }))).into_response())
}

// --- GET /threads/:id/runs --------------------------------------------------------

pub async fn runs_list(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    let db = shared_db(&state)?;
    if !db.thread_exists(&id).map_err(db_err)? {
        return Err(thread_not_found());
    }
    let runs = db.list_runs(&id).map_err(db_err)?;
    Ok(Json(json!({ "runs": runs })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_validation_matches_contract_enum() {
        assert!(is_valid_role("user"));
        assert!(is_valid_role("assistant"));
        assert!(is_valid_role("system"));
        assert!(!is_valid_role("not-a-role"));
        assert!(!is_valid_role(""));
    }

    #[test]
    fn parse_body_defaults_on_empty_bytes() {
        let parsed: CreateThreadBody = parse_body(&[]).unwrap();
        assert!(parsed.title.is_none());
    }

    #[test]
    fn parse_body_rejects_invalid_json() {
        let err = parse_body::<CreateThreadBody>(b"not json").unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
    }
}
