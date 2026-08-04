//! Admission helper for direct local-daemon routes that operate on sandbox
//! state without first passing through an intercepted Studio thread tool.

use crate::error::ApiResult;
use crate::sandbox::manager::AccountEpoch;
use crate::state::AppState;

#[derive(Clone, Copy)]
pub(crate) struct ExpectedIdentity {
    epoch: AccountEpoch,
    generation: u64,
}

impl ExpectedIdentity {
    pub(crate) fn new(epoch: AccountEpoch, generation: u64) -> Self {
        Self { epoch, generation }
    }
}

tokio::task_local! {
    /// Ingress identity for one intercepted app-API request. Interceptors
    /// acquire their own short account guards immediately before mutations;
    /// this inherited expectation makes those guards prove they still belong
    /// to the identity captured before request-body buffering.
    static EXPECTED_IDENTITY: ExpectedIdentity;
}

pub(crate) struct Authorization {
    epoch: AccountEpoch,
    _account: upstream::SessionTransitionGuard,
}

impl Authorization {
    pub(crate) fn epoch(&self) -> AccountEpoch {
        self.epoch
    }

    /// The upstream identity generation captured by the same transition
    /// guard that proved the account scope. Long-lived proxy requests pair
    /// this with subscriptions created before the guard is released, so an
    /// account replacement cannot hide in a validate/subscribe gap.
    pub(crate) fn identity_generation(&self) -> u64 {
        self._account.generation()
    }
}

/// Capture an opaque sandbox account ticket while the upstream account scope
/// is locked and revalidated. Callers pass the ticket through every manager
/// lookup or mutation; long work may release the upstream lock because the
/// manager rejects the ticket after an account transition.
pub(crate) async fn authorize(state: &AppState) -> ApiResult<Authorization> {
    let scope = super::threads::authority::current_account_scope().await?;
    let account = super::threads::authority::lock_account_scope(&scope).await?;
    Ok(Authorization {
        epoch: state.sandbox_manager.account_epoch(),
        _account: account,
    })
}

pub(crate) async fn with_expected_identity<F>(expected: ExpectedIdentity, future: F) -> F::Output
where
    F: std::future::Future,
{
    EXPECTED_IDENTITY.scope(expected, future).await
}

/// Called by the canonical account-scope lock. Outside an intercepted proxy
/// request there is no task-local expectation and the ordinary authorization
/// behavior is unchanged.
pub(crate) fn validate_expected_generation(generation: u64) -> ApiResult<()> {
    EXPECTED_IDENTITY
        .try_with(|expected| {
            if expected.generation == generation {
                Ok(())
            } else {
                Err(crate::error::ApiError::conflict(
                    "Your Studio account changed while this request was running. Try again.",
                ))
            }
        })
        .unwrap_or(Ok(()))
}

/// Sandbox admission additionally proves the native materialization epoch is
/// the one captured at ingress. Comparing the opaque ticket, rather than only
/// its account subject, also rejects logout/re-login of the same user.
pub(crate) fn validate_expected_epoch(epoch: AccountEpoch) -> ApiResult<()> {
    EXPECTED_IDENTITY
        .try_with(|expected| {
            if expected.epoch == epoch {
                Ok(())
            } else {
                Err(crate::error::ApiError::conflict(
                    "Your Studio account changed while this request was running. Try again.",
                ))
            }
        })
        .unwrap_or(Ok(()))
}
