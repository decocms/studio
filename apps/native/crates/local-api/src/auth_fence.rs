//! Ordering between process-global upstream credentials and account-scoped
//! interactive agent processes.

use std::sync::Arc;

use upstream::{PreparedSession, SessionIdentityEvent, StatusResult, UpstreamSession};

use crate::{AgentSessionRegistry, AppState};

#[derive(Debug, thiserror::Error)]
pub enum AccountInstallError {
    #[error(transparent)]
    Session(#[from] upstream::session::SessionError),
    #[error(transparent)]
    Storage(#[from] upstream::tokens::TokenStoreError),
    #[error("could not stop every coding agent before changing accounts: {0}")]
    AgentReap(String),
}

/// Install a prepared upstream session without ever exposing account B to a
/// PTY admitted for account A. Same-subject refreshes are intentionally kept
/// alive because the stable OAuth `sub` proves their account boundary did not
/// change.
pub async fn install_upstream_session(
    state: &AppState,
    prepared: PreparedSession,
) -> Result<StatusResult, AccountInstallError> {
    let session = upstream::global();
    let transition = session.begin_transition().await;
    let current_user_sub = transition.current_user_sub_result().await?;
    if should_reap_for_install(current_user_sub.as_deref(), prepared.user_sub()) {
        reap_all(&state.agent_sessions).await?;
    }
    Ok(transition.install(prepared).await?)
}

/// Explicit logout shares the same gate as terminal spawn and account install.
/// A successful signed-out transition is not reported complete until every
/// registered PTY has been reaped (or the failure has been logged).
pub async fn logout_upstream_session(state: &AppState) -> StatusResult {
    let session = upstream::global();
    let transition = session.begin_transition().await;
    let status = transition.logout().await;
    if !status.signed_in {
        log_reap_failure(reap_all(&state.agent_sessions).await, "logout");
    }
    status
}

/// Hard sign-out counterpart for request paths that directly observe a
/// rejected refresh token. Other hard sign-outs (including background
/// revalidation) are covered by [`spawn_identity_reaper`].
pub(crate) async fn hard_sign_out_upstream_session(state: &AppState, reason: &str) -> StatusResult {
    let session = upstream::global();
    let transition = session.begin_transition().await;
    let status = transition.hard_sign_out(reason).await;
    log_reap_failure(reap_all(&state.agent_sessions).await, "hard sign-out");
    status
}

pub(crate) async fn reap_all(registry: &AgentSessionRegistry) -> Result<(), AccountInstallError> {
    let failures = registry.terminate_all().await;
    let remaining = registry.active_count();
    if failures.is_empty() && remaining == 0 {
        return Ok(());
    }
    let mut details = failures;
    if remaining != 0 {
        details.push(format!("{remaining} terminal session(s) remain active"));
    }
    Err(AccountInstallError::AgentReap(details.join("; ")))
}

fn log_reap_failure(result: Result<(), AccountInstallError>, transition: &str) {
    if let Err(error) = result {
        tracing::error!(%error, %transition, "account transition did not reap every coding agent");
    }
}

fn should_reap_for_install(current_user_sub: Option<&str>, next_user_sub: &str) -> bool {
    current_user_sub != Some(next_user_sub)
}

/// Reaps on every non-coalesced hard signed-out identity event, including
/// those emitted before any status subscriber observed a signed-in value.
/// Generation comparison prevents a delayed event from killing terminals
/// admitted for a newer login; that newer install already performed its own
/// pre-commit reap.
pub(crate) fn spawn_identity_reaper(
    session: UpstreamSession,
    registry: Arc<AgentSessionRegistry>,
) -> tokio::task::JoinHandle<()> {
    let mut events = session.subscribe_identity();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => reap_identity_event(&session, &registry, event).await,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let transition = session.begin_transition().await;
                    match transition.current_user_sub_result().await {
                        Ok(None) => {
                            log_reap_failure(reap_all(&registry).await, "lagged hard sign-out");
                        }
                        Ok(Some(_)) => {}
                        Err(error) => {
                            tracing::warn!(%error, "could not reconcile a lagged auth transition");
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

async fn reap_identity_event(
    session: &UpstreamSession,
    registry: &AgentSessionRegistry,
    event: SessionIdentityEvent,
) {
    if event.user_sub.is_some() {
        return;
    }
    let transition = session.begin_transition().await;
    if !should_reap_identity_event(transition.generation(), &event) {
        return;
    }
    log_reap_failure(reap_all(registry).await, "hard sign-out event");
}

fn should_reap_identity_event(current_generation: u64, event: &SessionIdentityEvent) -> bool {
    event.user_sub.is_none() && current_generation == event.generation
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_replacement_and_post_signout_login_require_reap() {
        assert!(should_reap_for_install(Some("account-a"), "account-b"));
        assert!(should_reap_for_install(None, "account-a"));
    }

    #[test]
    fn same_subject_refresh_does_not_require_reap() {
        assert!(!should_reap_for_install(
            Some("stable-user-sub"),
            "stable-user-sub"
        ));
    }

    #[test]
    fn delayed_signed_out_event_cannot_reap_a_newer_login() {
        let signed_out = SessionIdentityEvent {
            generation: 4,
            user_sub: None,
        };
        assert!(should_reap_identity_event(4, &signed_out));
        assert!(!should_reap_identity_event(5, &signed_out));

        let signed_in = SessionIdentityEvent {
            generation: 5,
            user_sub: Some("account-b".to_string()),
        };
        assert!(!should_reap_identity_event(5, &signed_in));
    }
}
