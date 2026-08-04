//! Native thread persistence shared by the intercepted Studio tool surface
//! and interactive terminal lifecycle.
//!
//! Native clients use the production org-scoped thread tools intercepted in
//! `routes::intercept::thread_tools`; the retired bare `/threads*` mini-API is
//! intentionally absent. The SQLite schema remains compatible with existing
//! installations while its `rt_*` methods own the terminal-specific state.

pub(crate) mod authority;
pub(crate) mod db;

use std::sync::OnceLock;

use db::ThreadsDb;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

static DB: OnceLock<ThreadsDb> = OnceLock::new();

pub(crate) fn shared_db(state: &AppState) -> ApiResult<&'static ThreadsDb> {
    if let Some(db) = DB.get() {
        return Ok(db);
    }
    let opened = ThreadsDb::open(&state.app_root)
        .map_err(|e| ApiError::internal(format!("failed to open local thread database: {e}")))?;
    // Concurrent first callers may both open SQLite; only one process-lifetime
    // handle wins and the other connection is safely dropped.
    let _ = DB.set(opened);
    DB.get()
        .ok_or_else(|| ApiError::internal("thread database failed to initialize"))
}

pub(crate) fn db_err(error: db::DbError) -> ApiError {
    ApiError::internal(format!("thread database error: {error}"))
}
