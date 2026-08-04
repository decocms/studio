//! Canonical native account and thread authority resolution.

use axum::http::StatusCode;

use super::db::{RtAccountScope, RtThread, RtThreadFence, ThreadsDb};
use super::shared_db;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThreadAccess {
    Viewer,
    Owner,
    ActiveOwner,
}

pub(crate) struct ResolvedThread {
    pub db: &'static ThreadsDb,
    pub thread: RtThread,
    pub fence: RtThreadFence,
}

/// Black-box native suites run the standalone bearer server without an
/// interactive upstream login. The opt-in runner feature may pin one test
/// subject so those suites can exercise the authenticated account contract.
/// Shipping builds do not compile this seam.
#[cfg(all(not(test), feature = "e2e-runner"))]
fn e2e_account_sub() -> Option<String> {
    std::env::var("LOCAL_API_E2E_ACCOUNT_SUB")
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(not(test))]
pub(crate) async fn current_account_scope_result(
) -> Result<Option<RtAccountScope>, upstream::tokens::TokenStoreError> {
    let session = upstream::global();
    #[cfg(feature = "e2e-runner")]
    if let Some(user_id) = e2e_account_sub() {
        return Ok(RtAccountScope::new(session.host(), user_id));
    }
    let Some(user_id) = session.current_user_sub_result().await? else {
        return Ok(None);
    };
    Ok(RtAccountScope::new(session.host(), user_id))
}

#[cfg(test)]
pub(crate) async fn current_account_scope_result(
) -> Result<Option<RtAccountScope>, upstream::tokens::TokenStoreError> {
    Ok(RtAccountScope::new("test.invalid", "local-desktop-user"))
}

pub(crate) async fn current_account_scope() -> ApiResult<RtAccountScope> {
    current_account_scope_result()
        .await
        .map_err(|error| {
            tracing::warn!(%error, "could not load the current Studio account");
            ApiError::internal(
                "We couldn't confirm your Studio account. Restart Studio and try again; if needed, sign in again.",
            )
        })?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "Your Studio session expired. Sign in again.",
            )
        })
}

/// Acquires the process-wide account-transition fence and proves it still
/// names the account that authorized this request. When a thread lifecycle
/// lock is also required, callers acquire that lock first. Short durable
/// operations retain both guards through commit; long workspace I/O may drop
/// the account guard after its admission decision while retaining the
/// lifecycle guard.
#[cfg(not(test))]
pub(crate) async fn lock_account_scope(
    expected: &RtAccountScope,
) -> ApiResult<upstream::SessionTransitionGuard> {
    let session = upstream::global();
    let transition = session.begin_transition().await;
    let stored_user_id = transition.current_user_sub_result().await.map_err(|error| {
        tracing::warn!(%error, "could not verify Studio account under transition fence");
        ApiError::internal(
            "We couldn't confirm your Studio account. Restart Studio and try again; if needed, sign in again.",
        )
    })?;
    #[cfg(feature = "e2e-runner")]
    let current_user_id = e2e_account_sub().or(stored_user_id);
    #[cfg(not(feature = "e2e-runner"))]
    let current_user_id = stored_user_id;
    if !account_scope_matches(expected, session.host(), current_user_id.as_deref()) {
        return Err(ApiError::conflict(
            "Your Studio account changed while this request was waiting. Try again.",
        ));
    }
    crate::routes::sandbox_account::validate_expected_generation(transition.generation())?;
    Ok(transition)
}

#[cfg(test)]
pub(crate) async fn lock_account_scope(
    expected: &RtAccountScope,
) -> ApiResult<upstream::SessionTransitionGuard> {
    let session = upstream::global();
    let transition = session.begin_transition().await;
    if !account_scope_matches(expected, "test.invalid", Some("local-desktop-user")) {
        return Err(ApiError::conflict(
            "Your Studio account changed while this request was waiting. Try again.",
        ));
    }
    crate::routes::sandbox_account::validate_expected_generation(transition.generation())?;
    Ok(transition)
}

fn account_scope_matches(
    expected: &RtAccountScope,
    current_host: &str,
    current_user_id: Option<&str>,
) -> bool {
    current_user_id
        .and_then(|user_id| RtAccountScope::new(current_host, user_id))
        .is_some_and(|current| current == *expected)
}

pub(crate) async fn resolve_current_thread(
    state: &AppState,
    organization_id: &str,
    thread_id: &str,
    access: ThreadAccess,
) -> ApiResult<ResolvedThread> {
    let scope = current_account_scope().await?;
    resolve_scoped_thread(state, scope, organization_id, thread_id, access)
}

pub(crate) fn resolve_scoped_thread(
    state: &AppState,
    scope: RtAccountScope,
    organization_id: &str,
    thread_id: &str,
    access: ThreadAccess,
) -> ApiResult<ResolvedThread> {
    let db = shared_db(state).map_err(|error| {
        tracing::warn!(
            ?error,
            "could not open native thread storage for authority check"
        );
        ApiError::internal("We couldn't load this chat right now. Try again.")
    })?;
    let (thread, fence, delete_pending) = db
        .rt_get_thread_and_fence_in_scope(&scope, organization_id, thread_id)
        .map_err(|error| {
            tracing::warn!(%error, "could not resolve native thread authority");
            ApiError::internal("We couldn't load this chat right now. Try again.")
        })?
        .ok_or_else(|| ApiError::not_found("thread not found"))?;

    enforce_thread_access(
        access,
        &thread.created_by,
        &scope.user_id,
        thread.hidden,
        delete_pending,
    )?;

    Ok(ResolvedThread { db, thread, fence })
}

fn enforce_thread_access(
    access: ThreadAccess,
    created_by: &str,
    current_user_id: &str,
    hidden: bool,
    delete_pending: bool,
) -> ApiResult<()> {
    if matches!(access, ThreadAccess::Owner | ThreadAccess::ActiveOwner)
        && created_by != current_user_id
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "Only the chat owner can change this chat.",
        ));
    }
    if access == ThreadAccess::ActiveOwner && delete_pending {
        return Err(ApiError::conflict("This chat is being deleted."));
    }
    if access == ThreadAccess::ActiveOwner && hidden {
        return Err(ApiError::conflict(
            "This chat is archived. Restore it before opening the coding agent.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_owner_rejects_delete_pending_while_owner_retry_remains_allowed() {
        assert!(enforce_thread_access(ThreadAccess::Owner, "user", "user", false, true).is_ok());
        let error = enforce_thread_access(ThreadAccess::ActiveOwner, "user", "user", false, true)
            .unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(
            error.body,
            serde_json::json!({"error": "This chat is being deleted."})
        );
    }

    #[test]
    fn transition_scope_requires_the_same_host_and_subject() {
        let expected = RtAccountScope::new("studio.example", "user-a").unwrap();
        assert!(account_scope_matches(
            &expected,
            "STUDIO.EXAMPLE",
            Some("user-a")
        ));
        assert!(!account_scope_matches(
            &expected,
            "studio.example",
            Some("user-b")
        ));
        assert!(!account_scope_matches(
            &expected,
            "other.example",
            Some("user-a")
        ));
        assert!(!account_scope_matches(&expected, "studio.example", None));
    }
}
