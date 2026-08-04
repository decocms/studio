//! Ordering between process-global upstream credentials and account-scoped
//! interactive agent processes.

use upstream::{PreparedSession, SessionIdentityEvent, StatusResult, UpstreamSession};

use crate::AppState;

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
        reap_all(state).await?;
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
        log_reap_failure(reap_all(state).await, "logout");
    }
    status
}

/// Hard-sign-out a directly rejected refresh token only if the request that
/// observed it still names the current account. A delayed account-A failure
/// must never clear credentials installed for account B.
pub(crate) async fn hard_sign_out_upstream_session_if_current(
    state: &AppState,
    session: &UpstreamSession,
    expected_generation: u64,
    expected_epoch: crate::sandbox::manager::AccountEpoch,
    reason: &str,
) -> bool {
    let transition = session.begin_transition().await;
    if transition.generation() != expected_generation
        || state
            .sandbox_manager
            .validate_account_epoch(expected_epoch)
            .is_err()
    {
        return false;
    }
    transition.hard_sign_out(reason).await;
    log_reap_failure(reap_all(state).await, "hard sign-out");
    true
}

pub(crate) async fn reap_all(state: &AppState) -> Result<(), AccountInstallError> {
    let sandbox_transition = state
        .sandbox_manager
        .begin_account_transition()
        .await
        .map_err(AccountInstallError::AgentReap)?;
    let preparation = state.agent_sessions.cancel_all_preparations();
    let preparation_fences = preparation.fences();
    let mut failures = Vec::new();
    let first_preparation_error = preparation.wait().await.err();
    let first_sandbox_error = sandbox_transition.drain_and_stop_live().await.err();
    let preparation_quiesced = match first_preparation_error {
        None => true,
        Some(first_error) => match preparation.wait().await {
            Ok(()) => true,
            Err(error) => {
                failures.push(format!(
                    "managed coding agent artifacts were not removed because preparation remained active after sandbox shutdown and was unsafe to clean: {first_error}; retry: {error}"
                ));
                false
            }
        },
    };
    if preparation_quiesced {
        // The first sandbox drain can time out before taking a snapshot while
        // a canceled preparation still owns a materialization admission. The
        // successful preparation retry proves that admission is now gone, so
        // one idempotent drain retry is required before the transition gate
        // may reopen. A successful retry fully recovers the first timeout.
        if let Some(first_error) = first_sandbox_error {
            if let Err(error) = sandbox_transition.drain_and_stop_live().await {
                failures.push(format!(
                    "could not stop sandbox processes before changing accounts: {first_error}; retry: {error}"
                ));
            }
        }
        for fence in &preparation_fences {
            if let Err(error) =
                crate::terminal::launch_context::cleanup_managed_state(&state.app_root, fence).await
            {
                failures.push(format!(
                    "could not clean canceled coding agent preparation for {}: {error}",
                    fence.thread_id
                ));
            }
        }
    } else if let Some(error) = first_sandbox_error {
        failures.push(format!(
            "could not stop sandbox processes before changing accounts: {error}"
        ));
    }
    failures.extend(state.agent_sessions.terminate_active_sessions().await);
    let remaining = state.agent_sessions.active_count();
    if failures.is_empty() && remaining == 0 {
        return Ok(());
    }
    if remaining != 0 {
        failures.push(format!("{remaining} terminal session(s) remain active"));
    }
    Err(AccountInstallError::AgentReap(failures.join("; ")))
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
    state: AppState,
) -> tokio::task::JoinHandle<()> {
    let mut events = session.subscribe_identity();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => reap_identity_event(&session, &state, event).await,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let transition = session.begin_transition().await;
                    match transition.current_user_sub_result().await {
                        Ok(None) => {
                            log_reap_failure(reap_all(&state).await, "lagged hard sign-out");
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
    state: &AppState,
    event: SessionIdentityEvent,
) {
    if event.user_sub.is_some() {
        return;
    }
    let transition = session.begin_transition().await;
    if !should_reap_identity_event(transition.generation(), &event) {
        return;
    }
    log_reap_failure(reap_all(state).await, "hard sign-out event");
}

fn should_reap_identity_event(current_generation: u64, event: &SessionIdentityEvent) -> bool {
    event.user_sub.is_none() && current_generation == event.generation
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use upstream::tokens::{
        host_key, test_support::MemoryTokenStore, StoredSession, TokenStore, UserInfo,
    };

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

    #[tokio::test]
    async fn delayed_hard_sign_out_cannot_clear_replacement_credentials() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let expected_epoch = state.sandbox_manager.account_epoch();
        let target = "http://replacement.invalid";
        let host = host_key(target);
        let store = Arc::new(MemoryTokenStore::new());
        let account_a = StoredSession {
            target: target.to_string(),
            client_id: "client-a".to_string(),
            user: UserInfo {
                sub: "account-a".to_string(),
                email: None,
                name: None,
            },
            access_token: "token-a".to_string(),
            refresh_token: Some("refresh-a".to_string()),
            expires_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            cookie: None,
        };
        store.save(&host, account_a).await.unwrap();
        let session = UpstreamSession::new(target.to_string(), store.clone());
        let expected_generation = session.begin_transition().await.generation();

        session
            .begin_transition()
            .await
            .hard_sign_out("test replacement")
            .await;
        let account_b = StoredSession {
            target: target.to_string(),
            client_id: "client-b".to_string(),
            user: UserInfo {
                sub: "account-b".to_string(),
                email: None,
                name: None,
            },
            access_token: "token-b".to_string(),
            refresh_token: Some("refresh-b".to_string()),
            expires_at: None,
            created_at: "2026-01-01T00:00:00Z".to_string(),
            cookie: None,
        };
        store.save(&host, account_b).await.unwrap();

        assert!(
            !hard_sign_out_upstream_session_if_current(
                &state,
                &session,
                expected_generation,
                expected_epoch,
                "delayed account-a rejection",
            )
            .await
        );
        let stored = store.load(&host).await.unwrap().unwrap();
        assert_eq!(stored.user.sub, "account-b");
        assert_eq!(stored.access_token, "token-b");
    }

    #[tokio::test]
    async fn account_reap_stops_real_and_synthetic_sandbox_generations() {
        let root = tempfile::tempdir().unwrap();
        let state = crate::routes::intercept::test_state(root.path());
        let real_handle = state
            .sandbox_manager
            .register_for_test("https://github.com/acme/auth-real.git", "feature/account-a");
        let synthetic_handle = state.sandbox_manager.register_for_test(
            "https://github.com/acme/auth-synthetic.git",
            "thread:account-a-thread",
        );
        let account_epoch = state.sandbox_manager.account_epoch();
        let real = state
            .sandbox_manager
            .adopt_for_account(account_epoch, &real_handle)
            .await
            .unwrap()
            .unwrap();
        let synthetic = state
            .sandbox_manager
            .adopt_for_account(account_epoch, &synthetic_handle)
            .await
            .unwrap()
            .unwrap();

        reap_all(&state).await.unwrap();
        let current_epoch = state.sandbox_manager.account_epoch();

        for (handle, generation) in [(&real_handle, real), (&synthetic_handle, synthetic)] {
            assert!(state
                .sandbox_manager
                .get_for_account(current_epoch, handle)
                .unwrap()
                .is_none());
            assert!(generation.tasks.is_admission_closed());
            assert!(generation.tasks.list(None).is_empty());
            assert_eq!(
                state
                    .sandbox_manager
                    .registry_record_for_account(current_epoch, handle)
                    .unwrap()
                    .unwrap()
                    .desired_status,
                "stopped"
            );
        }
    }
}
