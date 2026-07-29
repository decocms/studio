//! Native `/api/:org/watch` event stream.
//!
//! Native threads live only in the local SQLite database, so the upstream
//! Studio watch stream can never describe their lifecycle. This module is the
//! local equivalent of Studio's SSE hub. It deliberately never opens or merges
//! the upstream `/watch` stream: native mode's watch contract is local changes
//! only. Listeners are isolated by authenticated account and organization,
//! events are fanned out only after the corresponding SQLite transaction
//! commits, and no history is retained in memory. Clients recover a
//! disconnected gap through their existing `COLLECTION_THREADS_LIST`
//! reconnect reconciliation.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::response::{IntoResponse, Response};
use futures::stream;
use serde::Serialize;
use serde_json::json;
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::ApiError;
use crate::routes::threads::db::{RtAccountScope, RtThread, RtThreadFence};

const THREAD_STATUS_EVENT: &str = "decopilot.thread.status";
const LISTENER_CAPACITY: usize = 64;
const MAX_CONNECTIONS_PER_SCOPE: usize = 50;
const MAX_TOTAL_CONNECTIONS: usize = 500;

/// How long a silent stream waits before writing a heartbeat.
///
/// The heartbeat is not for the client — nothing listens for it — but for the
/// socket. A stream with no traffic cannot tell a quiet organization from a
/// peer that went away, and native restarts the listener often enough that
/// half-open sockets are routine rather than exotic. Writing on an interval
/// turns that into an error the client can see and reconnect from.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);

/// Reconnection delay handed to `EventSource` through the SSE `retry:` field.
///
/// Every stream opens with it, healthy or refused, because a browser can only
/// honour a `retry:` it has actually received — the default otherwise is the
/// implementation's own, which WebKit does not document.
const RECONNECT_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ThreadStatus {
    InProgress,
    Completed,
    RequiresAction,
    Failed,
}

impl ThreadStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::RequiresAction => "requires_action",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct LocalWatchEvent {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    source: String,
    subject: String,
    data: serde_json::Value,
    time: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct ListenerScope {
    account_scope: String,
    organization_id: String,
}

struct Listener {
    type_patterns: Option<Vec<String>>,
    sender: mpsc::Sender<Bytes>,
}

#[derive(Default)]
struct LocalWatchHub {
    listeners: Mutex<HashMap<ListenerScope, HashMap<Uuid, Listener>>>,
}

impl LocalWatchHub {
    fn lock(&self) -> MutexGuard<'_, HashMap<ListenerScope, HashMap<Uuid, Listener>>> {
        self.listeners
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn subscribe(
        &'static self,
        scope: ListenerScope,
        type_patterns: Option<Vec<String>>,
    ) -> Result<Subscription, SubscribeError> {
        let id = Uuid::new_v4();
        let (sender, receiver) = mpsc::channel(LISTENER_CAPACITY);
        let mut listeners = self.lock();
        let total: usize = listeners.values().map(|scoped| scoped.len()).sum();
        if total >= MAX_TOTAL_CONNECTIONS {
            return Err(SubscribeError::TotalLimit);
        }
        let scoped = listeners.entry(scope.clone()).or_default();
        if scoped.len() >= MAX_CONNECTIONS_PER_SCOPE {
            return Err(SubscribeError::ScopeLimit);
        }
        scoped.insert(
            id,
            Listener {
                type_patterns,
                sender,
            },
        );
        Ok(Subscription {
            hub: self,
            scope,
            id,
            receiver,
        })
    }

    fn emit(&self, scope: &ListenerScope, event: &LocalWatchEvent) {
        let frame = match event_frame(event) {
            Ok(frame) => frame,
            Err(error) => {
                tracing::error!(%error, "failed to serialize native watch event");
                return;
            }
        };
        let mut listeners = self.lock();
        let Some(scoped) = listeners.get_mut(scope) else {
            return;
        };
        scoped.retain(|_, listener| {
            if !matches_patterns(&event.event_type, listener.type_patterns.as_deref()) {
                return true;
            }
            match listener.sender.try_send(frame.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Closed(_))
                | Err(mpsc::error::TrySendError::Full(_)) => false,
            }
        });
        if scoped.is_empty() {
            listeners.remove(scope);
        }
    }

    fn remove(&self, scope: &ListenerScope, id: Uuid) {
        let mut listeners = self.lock();
        let Some(scoped) = listeners.get_mut(scope) else {
            return;
        };
        scoped.remove(&id);
        if scoped.is_empty() {
            listeners.remove(scope);
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubscribeError {
    ScopeLimit,
    TotalLimit,
}

struct Subscription {
    hub: &'static LocalWatchHub,
    scope: ListenerScope,
    id: Uuid,
    receiver: mpsc::Receiver<Bytes>,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.hub.remove(&self.scope, self.id);
    }
}

struct WatchStream {
    initial: Option<Bytes>,
    subscription: Subscription,
}

fn hub() -> &'static LocalWatchHub {
    static HUB: OnceLock<LocalWatchHub> = OnceLock::new();
    HUB.get_or_init(LocalWatchHub::default)
}

fn listener_scope(account_scope: String, organization_id: impl Into<String>) -> ListenerScope {
    ListenerScope {
        account_scope,
        organization_id: organization_id.into(),
    }
}

fn matches_patterns(event_type: &str, patterns: Option<&[String]>) -> bool {
    let Some(patterns) = patterns else {
        return true;
    };
    patterns
        .iter()
        .any(|pattern| match pattern.strip_suffix('*') {
            Some(prefix) => event_type.starts_with(prefix),
            None => event_type == pattern,
        })
}

fn parse_type_patterns(query: Option<&str>) -> Result<Option<Vec<String>>, ApiError> {
    let Some(raw) = query.and_then(|query| {
        query.split('&').find_map(|field| {
            let (name, value) = field.split_once('=').unwrap_or((field, ""));
            (name == "types").then_some(value)
        })
    }) else {
        return Ok(None);
    };
    let decoded = urlencoding::decode(raw)
        .map_err(|error| ApiError::bad_request(format!("invalid types query: {error}")))?;
    let patterns: Vec<String> = decoded
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    if let Some(invalid) = patterns.iter().find(|pattern| !valid_type_pattern(pattern)) {
        return Err(ApiError::bad_request(format!(
            "invalid watch type pattern: {invalid}"
        )));
    }
    Ok((!patterns.is_empty()).then_some(patterns))
}

fn valid_type_pattern(pattern: &str) -> bool {
    let Some(prefix) = pattern.strip_suffix(".*") else {
        return !pattern.contains('*');
    };
    !prefix.is_empty() && !prefix.contains('*')
}

fn connected_frame(
    listener_id: Uuid,
    organization_id: &str,
    type_patterns: Option<&[String]>,
) -> Bytes {
    let connected_at = crate::routes::threads::db::now_rfc3339();
    let data = json!({
        "listenerId": listener_id.to_string(),
        "organizationId": organization_id,
        "typePatterns": type_patterns,
        "connectedAt": connected_at,
    });
    Bytes::from(format!(
        "{}event: connected\ndata: {data}\n\n",
        retry_directive()
    ))
}

/// The `retry:` field, as the first thing in every stream this route writes.
fn retry_directive() -> String {
    format!("retry: {}\n\n", RECONNECT_DELAY.as_millis())
}

fn sse_response(body: Body) -> Response {
    crate::http_util::event_stream_response(body, "native watch response")
}

/// A refusal the client is expected to come back from.
///
/// `EventSource` treats any status other than 200 — and any content type that
/// is not `text/event-stream` — as *fatal*: it fires `error`, moves to
/// `CLOSED`, and never reconnects for the life of the page. Every reason this
/// route can refuse is temporary. The Keychain session is not loaded yet
/// milliseconds after the listener restarts; queue recovery is still running;
/// a connection cap will be freed by the tab that is closing. Answering any of
/// those with a status code strands a live page with no events at all until
/// someone reloads it by hand — which is precisely the failure this exists to
/// prevent, since a native rebuild restarts the listener under a webview that
/// keeps running.
///
/// So a refusal is itself a well-formed stream that ends immediately. The
/// browser sees an ordinary disconnect, waits [`RECONNECT_DELAY`], and tries
/// again; the reason rides along as a comment, visible in the network panel
/// and ignored by the parser.
pub(crate) fn retryable_refusal(reason: &str) -> Response {
    tracing::debug!(reason, "native watch refused; client will reconnect");
    sse_response(Body::from(format!("{}: {reason}\n\n", retry_directive())))
}

fn event_frame(event: &LocalWatchEvent) -> Result<Bytes, serde_json::Error> {
    let data = serde_json::to_string(event)?;
    Ok(Bytes::from(format!(
        "id: {}\nevent: {}\ndata: {data}\n\n",
        event.id, event.event_type
    )))
}

pub(crate) fn get(scope: &RtAccountScope, organization_id: &str, query: Option<&str>) -> Response {
    if organization_id.is_empty() {
        return ApiError::bad_request("organization id missing").into_response();
    }
    let type_patterns = match parse_type_patterns(query) {
        Ok(patterns) => patterns,
        Err(error) => return error.into_response(),
    };
    let subscription = match hub().subscribe(
        listener_scope(scope.storage_key(), organization_id),
        type_patterns.clone(),
    ) {
        Ok(subscription) => subscription,
        Err(SubscribeError::ScopeLimit) => {
            return retryable_refusal(
                "watch connection limit reached for this account and organization",
            );
        }
        Err(SubscribeError::TotalLimit) => {
            return retryable_refusal("watch total connection limit reached");
        }
    };
    let initial = connected_frame(subscription.id, organization_id, type_patterns.as_deref());
    let stream_state = WatchStream {
        initial: Some(initial),
        subscription,
    };
    let body_stream = stream::unfold(stream_state, |mut state| async move {
        if let Some(initial) = state.initial.take() {
            return Some((Ok::<_, Infallible>(initial), state));
        }
        match tokio::time::timeout(KEEPALIVE_INTERVAL, state.subscription.receiver.recv()).await {
            Ok(Some(frame)) => Some((Ok(frame), state)),
            Ok(None) => None,
            Err(_) => Some((
                Ok(Bytes::from_static(b"event: keepalive\ndata: \n\n")),
                state,
            )),
        }
    });

    sse_response(Body::from_stream(body_stream))
}

/// Publishes the exact production-shaped status event after its SQLite
/// transition committed. Scope is taken from the same generation fence that
/// owned the write, preventing another signed-in account or organization from
/// observing the event.
pub(crate) fn emit_thread_status(
    fence: &RtThreadFence,
    status: ThreadStatus,
    thread: &RtThread,
    message_id: Option<&str>,
) {
    let mut data = json!({
        "status": status.as_str(),
        "virtual_mcp_id": thread.virtual_mcp_id,
        "created_by": thread.created_by,
        "trigger_id": thread.trigger_id,
        "title": thread.title,
        "branch": thread.branch,
        "created_at": thread.created_at,
        "updated_at": thread.updated_at,
    });
    if let Some(metadata) = thread.metadata.as_ref() {
        data["metadata"] = metadata.clone();
    }
    if let Some(message_id) = message_id {
        data["message_id"] = serde_json::Value::String(message_id.to_string());
    }
    let event = LocalWatchEvent {
        id: Uuid::new_v4().to_string(),
        event_type: THREAD_STATUS_EVENT.to_string(),
        source: "decopilot".to_string(),
        subject: fence.thread_id.clone(),
        data,
        time: crate::routes::threads::db::now_rfc3339(),
    };
    hub().emit(
        &listener_scope(fence.account_scope.clone(), fence.organization_id.clone()),
        &event,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, StatusCode};
    use futures::StreamExt;

    fn scope(user: &str) -> RtAccountScope {
        RtAccountScope::new("studio.decocms.com", user).unwrap()
    }

    fn fence(scope: &RtAccountScope, organization_id: &str, thread_id: &str) -> RtThreadFence {
        RtThreadFence {
            account_scope: scope.storage_key(),
            organization_id: organization_id.to_string(),
            thread_id: thread_id.to_string(),
            generation: Uuid::new_v4().to_string(),
        }
    }

    fn thread_row(fence: &RtThreadFence, status: ThreadStatus, updated_at: &str) -> RtThread {
        RtThread {
            id: fence.thread_id.clone(),
            organization_id: fence.organization_id.clone(),
            title: "Local thread".to_string(),
            description: None,
            hidden: false,
            status: status.as_str().to_string(),
            created_by: "alice".to_string(),
            updated_by: None,
            virtual_mcp_id: "vir_local".to_string(),
            trigger_id: None,
            branch: Some("feature/native".to_string()),
            sandbox_provider_kind: Some("user-desktop".to_string()),
            harness_id: Some("claude-code".to_string()),
            metadata: Some(json!({"kind": "agent"})),
            run_config: None,
            created_at: "2026-07-24T11:00:00.000Z".to_string(),
            updated_at: updated_at.to_string(),
        }
    }

    async fn next_frame(stream: &mut axum::body::BodyDataStream) -> String {
        let chunk = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("watch frame timed out")
            .expect("watch stream ended")
            .expect("watch frame failed");
        String::from_utf8(chunk.to_vec()).unwrap()
    }

    #[tokio::test]
    async fn emits_connected_then_committed_status_wire_shape() {
        let account = scope("alice");
        let org = format!("org-{}", Uuid::new_v4());
        let response = get(
            &account,
            &org,
            Some("types=decopilot.thread.status,task-board.item.updated"),
        );
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        let mut stream = response.into_body().into_data_stream();

        let connected = next_frame(&mut stream).await;
        assert!(
            connected.starts_with("retry: 3000\n\n"),
            "a stream must state its reconnect delay before anything else: {connected:?}"
        );
        assert!(connected.contains("event: connected"));
        assert!(connected.contains(&org));
        assert!(!connected.contains("event: snapshot"));

        let thread_fence = fence(&account, &org, "thread-1");
        let running = thread_row(
            &thread_fence,
            ThreadStatus::InProgress,
            "2026-07-24T12:00:00.000Z",
        );
        emit_thread_status(
            &thread_fence,
            ThreadStatus::InProgress,
            &running,
            Some("message-1"),
        );
        let status = next_frame(&mut stream).await;
        assert!(status.contains("event: decopilot.thread.status"));
        let data = status
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(data).unwrap();
        assert_eq!(parsed["subject"], "thread-1");
        assert_eq!(parsed["data"]["status"], "in_progress");
        assert_eq!(parsed["data"]["message_id"], "message-1");
        assert_eq!(parsed["data"]["updated_at"], "2026-07-24T12:00:00.000Z");
        assert_eq!(parsed["data"]["virtual_mcp_id"], "vir_local");
        assert_eq!(parsed["data"]["created_by"], "alice");
        assert_eq!(parsed["data"]["title"], "Local thread");
        assert_eq!(parsed["data"]["branch"], "feature/native");
        assert_eq!(parsed["data"]["created_at"], "2026-07-24T11:00:00.000Z");
        assert_eq!(parsed["data"]["metadata"]["kind"], "agent");

        let paused = thread_row(
            &thread_fence,
            ThreadStatus::RequiresAction,
            "2026-07-24T12:00:01.000Z",
        );
        emit_thread_status(&thread_fence, ThreadStatus::RequiresAction, &paused, None);
        let terminal = next_frame(&mut stream).await;
        let data = terminal
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        let parsed: serde_json::Value = serde_json::from_str(data).unwrap();
        assert_eq!(parsed["data"]["status"], "requires_action");
        assert!(
            parsed["data"].get("message_id").is_none(),
            "terminal events must omit message_id rather than serialize null"
        );
    }

    #[tokio::test]
    async fn isolates_events_by_account_and_organization() {
        let alice = scope("alice");
        let bob = scope("bob");
        let alice_org = format!("org-{}", Uuid::new_v4());
        let other_org = format!("org-{}", Uuid::new_v4());
        let response = get(&alice, &alice_org, Some("types=decopilot.thread.*"));
        let mut stream = response.into_body().into_data_stream();
        let _ = next_frame(&mut stream).await;

        let bob_thread = fence(&bob, &alice_org, "bob-thread");
        emit_thread_status(
            &bob_thread,
            ThreadStatus::Completed,
            &thread_row(
                &bob_thread,
                ThreadStatus::Completed,
                "2026-07-24T12:00:00.000Z",
            ),
            None,
        );
        let other_org_thread = fence(&alice, &other_org, "other-org-thread");
        emit_thread_status(
            &other_org_thread,
            ThreadStatus::Completed,
            &thread_row(
                &other_org_thread,
                ThreadStatus::Completed,
                "2026-07-24T12:00:00.000Z",
            ),
            None,
        );
        let leaked = tokio::time::timeout(Duration::from_millis(50), stream.next()).await;
        assert!(leaked.is_err(), "cross-scope event leaked to listener");

        let alice_thread = fence(&alice, &alice_org, "alice-thread");
        emit_thread_status(
            &alice_thread,
            ThreadStatus::Completed,
            &thread_row(
                &alice_thread,
                ThreadStatus::Completed,
                "2026-07-24T12:00:01.000Z",
            ),
            None,
        );
        let status = next_frame(&mut stream).await;
        assert!(status.contains("alice-thread"));
    }

    #[tokio::test]
    async fn bounds_connections_per_account_and_organization() {
        let account = scope(&format!("limit-user-{}", Uuid::new_v4()));
        let org = format!("org-{}", Uuid::new_v4());
        let mut responses = Vec::new();
        for _ in 0..MAX_CONNECTIONS_PER_SCOPE {
            let response = get(&account, &org, None);
            assert_eq!(response.status(), StatusCode::OK);
            responses.push(response);
        }

        // A refused connection is still a 200 `text/event-stream` that ends
        // right away: anything else is fatal to `EventSource` and would cost
        // the page every later event, not just this one.
        let rejected = get(&account, &org, None);
        assert_eq!(rejected.status(), StatusCode::OK);
        assert_eq!(
            rejected.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        let mut refused = rejected.into_body().into_data_stream();
        let body = next_frame(&mut refused).await;
        assert!(body.starts_with("retry: 3000\n\n"), "{body:?}");
        assert!(
            body.contains(": watch connection limit reached"),
            "{body:?}"
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(1), refused.next())
                .await
                .expect("a refusal must end rather than hang")
                .is_none(),
            "a refusal must end the stream so the browser reconnects"
        );
        drop(responses);

        let reopened = get(&account, &org, None);
        assert_eq!(reopened.status(), StatusCode::OK);
        let mut reopened = reopened.into_body().into_data_stream();
        assert!(next_frame(&mut reopened).await.contains("event: connected"));
    }

    /// Every refusal path shares one shape, because `EventSource` gives a page
    /// exactly one chance: a status code here means no events until a reload.
    #[tokio::test]
    async fn a_refusal_is_a_reconnectable_stream_not_a_status_code() {
        let response = retryable_refusal("no signed-in account yet");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream"
        );
        let mut stream = response.into_body().into_data_stream();
        let body = next_frame(&mut stream).await;
        assert_eq!(body, "retry: 3000\n\n: no signed-in account yet\n\n");
        assert!(tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("a refusal must end rather than hang")
            .is_none());
    }

    #[test]
    fn bounds_connections_process_wide() {
        let hub = Box::leak(Box::new(LocalWatchHub::default()));
        let mut subscriptions = Vec::new();
        for index in 0..MAX_TOTAL_CONNECTIONS {
            subscriptions.push(
                hub.subscribe(
                    ListenerScope {
                        account_scope: format!("account-{index}"),
                        organization_id: format!("org-{index}"),
                    },
                    None,
                )
                .expect("connection below process-wide cap must be accepted"),
            );
        }

        let rejected = hub.subscribe(
            ListenerScope {
                account_scope: "overflow-account".to_string(),
                organization_id: "overflow-org".to_string(),
            },
            None,
        );
        assert!(matches!(rejected, Err(SubscribeError::TotalLimit)));
        drop(subscriptions);

        let reopened = hub.subscribe(
            ListenerScope {
                account_scope: "reopened-account".to_string(),
                organization_id: "reopened-org".to_string(),
            },
            None,
        );
        assert!(reopened.is_ok());
    }

    #[test]
    fn type_patterns_match_exact_and_wildcard_suffix() {
        let exact = vec!["decopilot.thread.status".to_string()];
        let wildcard = vec!["decopilot.*".to_string()];
        let other = vec!["task-board.*".to_string()];
        assert!(matches_patterns(THREAD_STATUS_EVENT, Some(&exact)));
        assert!(matches_patterns(THREAD_STATUS_EVENT, Some(&wildcard)));
        assert!(!matches_patterns(THREAD_STATUS_EVENT, Some(&other)));
        assert!(matches_patterns(THREAD_STATUS_EVENT, None));
    }

    #[test]
    fn malformed_type_filters_are_rejected_instead_of_broadening() {
        assert!(parse_type_patterns(Some("types=%FF")).is_err());
        assert!(parse_type_patterns(Some("types=*")).is_err());
        assert!(parse_type_patterns(Some("types=.*")).is_err());
        assert!(parse_type_patterns(Some("types=decopilot*")).is_err());
        assert!(parse_type_patterns(Some("types=decopilot.*.status")).is_err());
        assert_eq!(
            parse_type_patterns(Some("types=decopilot.*,task-board.item.updated")).unwrap(),
            Some(vec![
                "decopilot.*".to_string(),
                "task-board.item.updated".to_string()
            ])
        );
        assert_eq!(parse_type_patterns(Some("types=")).unwrap(), None);
    }
}
