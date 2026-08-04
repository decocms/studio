//! Account and thread authority for native sandbox interceptions.
//!
//! Every local sandbox route is behind two independent fences: the loopback
//! bearer proves the caller is the embedded app, while this module proves the
//! app still has a signed-in Studio account. A `thread:<id>` branch carries
//! enough information to apply the canonical local thread authority as well.
//! Ordinary git branches do not, so they remain account-authenticated without
//! claiming cross-account ownership isolation the URL cannot prove. The
//! account-transition gate fences admission only; it is released before any
//! potentially long workspace I/O so account switching cannot be starved.

use crate::error::{ApiError, ApiResult};
use crate::routes::threads::authority::{self, ThreadAccess};
use crate::sandbox::manager::SandboxAccount;
use crate::state::AppState;
use tokio::sync::OwnedMutexGuard;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Access {
    Viewer,
    ActiveOwner,
    Recovery,
    WorkspaceMutation,
}

/// Keeps an ordinary thread-backed workspace mutation inside the same
/// lifecycle critical section as terminal start, archive, and delete.
/// Recovery controls intentionally carry no lifecycle guard so they can stop
/// the operation holding it.
#[must_use = "dropping sandbox authority releases its thread lifecycle lock"]
pub(super) struct Authorization {
    account: SandboxAccount,
    identity_generation: u64,
    _owner_guard: Option<OwnedMutexGuard<()>>,
}

impl Authorization {
    pub(super) fn account(&self) -> &SandboxAccount {
        &self.account
    }

    pub(super) fn identity_generation(&self) -> u64 {
        self.identity_generation
    }
}

/// Require a current account and, for a thread-backed sandbox, resolve the
/// named thread under that same account/org scope and verify its virtual MCP.
pub(super) async fn authorize(
    state: &AppState,
    org: &str,
    virtual_mcp_id: &str,
    branch: &str,
    access: Access,
) -> ApiResult<Authorization> {
    let scope = authority::current_account_scope().await?;
    let Some(thread_id) = thread_id(branch)? else {
        // Ordinary branches have no thread row from which to derive a
        // lifecycle owner, but their admission still has to linearize with
        // logout/account replacement. Release the transition gate before the
        // potentially long workspace operation; this is point-in-time account
        // authentication, not tenant ownership for the machine-wide registry.
        let account_guard = authority::lock_account_scope(&scope).await?;
        let account = crate::routes::sandbox_account::admit_scope(state, &scope)?;
        let identity_generation = account_guard.generation();
        drop(account_guard);
        return Ok(Authorization {
            account,
            identity_generation,
            _owner_guard: None,
        });
    };

    if access == Access::Viewer {
        let account_guard = authority::lock_account_scope(&scope).await?;
        let account = crate::routes::sandbox_account::admit_scope(state, &scope)?;
        let resolved =
            authority::resolve_scoped_thread(state, scope, org, thread_id, ThreadAccess::Viewer)?;
        verify_virtual_mcp(&resolved.thread.virtual_mcp_id, virtual_mcp_id)?;
        let identity_generation = account_guard.generation();
        drop(account_guard);
        return Ok(Authorization {
            account,
            identity_generation,
            _owner_guard: None,
        });
    }

    if matches!(access, Access::ActiveOwner | Access::Recovery) {
        // Controls and potentially long viewer-adjacent I/O must be admitted
        // under a stable account identity, but must never queue behind a
        // workspace operation. Recovery deliberately accepts an archived or
        // delete-pending owned thread so stop/kill/delete can finish cleanup;
        // preview invocation still requires ActiveOwner.
        let account_guard = authority::lock_account_scope(&scope).await?;
        let thread_access = if access == Access::Recovery {
            ThreadAccess::Owner
        } else {
            ThreadAccess::ActiveOwner
        };
        let account = crate::routes::sandbox_account::admit_scope(state, &scope)?;
        let resolved =
            authority::resolve_scoped_thread(state, scope, org, thread_id, thread_access)?;
        verify_virtual_mcp(&resolved.thread.virtual_mcp_id, virtual_mcp_id)?;
        let identity_generation = account_guard.generation();
        drop(account_guard);
        return Ok(Authorization {
            account,
            identity_generation,
            _owner_guard: None,
        });
    }

    // Resolve once to select the canonical per-generation lock, then resolve
    // again after winning it. Archive/delete/terminal transitions use this
    // same lock, so whichever operation wins is visible to the loser before
    // it can touch the workspace.
    let initial = authority::resolve_scoped_thread(
        state,
        scope.clone(),
        org,
        thread_id,
        ThreadAccess::ActiveOwner,
    )?;
    verify_virtual_mcp(&initial.thread.virtual_mcp_id, virtual_mcp_id)?;
    let initial_fence = initial.fence;
    let owner_guard = state
        .agent_sessions
        .start_lock(&initial_fence)
        .lock_owned()
        .await;
    let account_guard = authority::lock_account_scope(&scope).await?;

    // Re-read the row while both admission fences are held. The account gate
    // is released immediately after this decision; keeping it through setup,
    // exec, preview, or filesystem I/O would indefinitely block logout and
    // account switching. The thread lifecycle gate remains held through the
    // workspace side effect.
    let account = crate::routes::sandbox_account::admit_scope(state, &scope)?;
    let resolved =
        authority::resolve_scoped_thread(state, scope, org, thread_id, ThreadAccess::ActiveOwner)?;
    if resolved.fence != initial_fence {
        return Err(ApiError::not_found("sandbox not found"));
    }
    verify_virtual_mcp(&resolved.thread.virtual_mcp_id, virtual_mcp_id)?;
    let identity_generation = account_guard.generation();
    drop(account_guard);
    Ok(Authorization {
        account,
        identity_generation,
        _owner_guard: Some(owner_guard),
    })
}

/// Authentication for intercepted sandbox reads that do not identify one
/// thread (for example a virtual-MCP list or an unfiltered session list).
pub(super) async fn require_account(state: &AppState) -> ApiResult<Authorization> {
    let scope = authority::current_account_scope().await?;
    let account_guard = authority::lock_account_scope(&scope).await?;
    let account = crate::routes::sandbox_account::admit_scope(state, &scope)?;
    let identity_generation = account_guard.generation();
    drop(account_guard);
    Ok(Authorization {
        account,
        identity_generation,
        _owner_guard: None,
    })
}

fn thread_id(branch: &str) -> ApiResult<Option<&str>> {
    crate::sandbox::synthetic_thread_id_from_input(branch).map_err(ApiError::bad_request)
}

fn verify_virtual_mcp(actual: &str, requested: &str) -> ApiResult<()> {
    if actual != requested {
        return Err(ApiError::not_found("sandbox not found"));
    }
    Ok(())
}

pub(super) fn manager_error(error: String) -> ApiError {
    if error.contains("stale account epoch") || error.contains("account transition") {
        ApiError::conflict("Your Studio account changed while this request was running. Try again.")
    } else {
        ApiError::internal(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_complete_thread_backed_branches() {
        assert_eq!(thread_id("thread:chat-1").unwrap(), Some("chat-1"));
        assert_eq!(
            thread_id("thread:chat-1/connection-2").unwrap(),
            Some("chat-1")
        );
        assert_eq!(thread_id("feature/thread:chat-1").unwrap(), None);
        assert_eq!(thread_id("ephemeral").unwrap(), None);
        assert!(thread_id(" thread:chat-1 ").is_err());
        assert!(thread_id("thread:").is_err());
        assert!(thread_id("thread:/connection-2").is_err());
        assert!(thread_id("thread:chat-1/").is_err());
    }

    #[tokio::test]
    async fn authorization_holds_the_lifecycle_lock_until_dropped() {
        let root = tempfile::tempdir().unwrap();
        let state = super::super::test_state(root.path());
        let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let scope =
            crate::routes::threads::db::RtAccountScope::new("test.invalid", "local-desktop-user")
                .unwrap();
        let authorization = Authorization {
            account: state
                .sandbox_manager
                .sandbox_account(state.sandbox_manager.account_epoch(), &scope)
                .unwrap(),
            identity_generation: 0,
            _owner_guard: Some(lock.clone().lock_owned().await),
        };
        assert!(lock.try_lock().is_err());

        drop(authorization);
        assert!(lock.try_lock().is_ok());
    }
}
