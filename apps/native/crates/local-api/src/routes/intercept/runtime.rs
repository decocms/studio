//! Which session is asking, on this machine.
//!
//! The shared web UI appends `?thread=<id>` to every `/api/:org/sandbox/**`
//! request because a branch does not identify a runtime — a coding session and
//! the CMS draft share one. The interceptors below it route by LOCAL WORKTREE
//! PRESENCE, which is the same mistake the cloud claim used to make: a
//! worktree that exists says nothing about whether THIS chat is a coding
//! session.
//!
//! So: a thread stamped `cms` never gets a local worktree, whatever the
//! registry holds. Only a literal stamp counts — an unstamped or unknown local
//! row keeps today's presence routing, because native has no vMCP row to read a
//! project default from.

use crate::routes::threads::shared_db;
use crate::state::AppState;

/// The `thread` query parameter, if the caller sent one.
pub(super) fn thread_id_from_query(query: Option<&str>) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let Some((key, value)) = pair.split_once('=') else {
            continue;
        };
        if key == "thread" && !value.is_empty() {
            return urlencoding::decode(value)
                .ok()
                .map(|decoded| decoded.into_owned());
        }
    }
    None
}

/// True only when the asking thread is stamped `cms` in the local database.
pub(super) fn thread_is_cms(state: &AppState, query: Option<&str>) -> bool {
    let Some(thread_id) = thread_id_from_query(query) else {
        return false;
    };
    let Ok(db) = shared_db(state) else {
        return false;
    };
    let Ok(Some(thread)) = db.rt_get_thread(&thread_id) else {
        return false;
    };
    thread
        .metadata
        .as_ref()
        .and_then(|value| value.get("runtime"))
        .and_then(|value| value.as_str())
        == Some("cms")
}

#[cfg(test)]
mod tests {
    use super::thread_id_from_query;

    #[test]
    fn reads_the_thread_selector() {
        assert_eq!(
            thread_id_from_query(Some("thread=thrd_1")).as_deref(),
            Some("thrd_1")
        );
        assert_eq!(
            thread_id_from_query(Some("path=%2F&thread=thrd_2")).as_deref(),
            Some("thrd_2")
        );
        assert_eq!(
            thread_id_from_query(Some("thread=thrd%2F3")).as_deref(),
            Some("thrd/3")
        );
    }

    #[test]
    fn absent_or_empty_is_no_thread() {
        assert_eq!(thread_id_from_query(None), None);
        assert_eq!(thread_id_from_query(Some("")), None);
        assert_eq!(thread_id_from_query(Some("path=%2F")), None);
        assert_eq!(thread_id_from_query(Some("thread=")), None);
    }

    /// A valueless pair must not abort the scan — the selector may follow it.
    #[test]
    fn a_bare_flag_does_not_hide_the_selector() {
        assert_eq!(
            thread_id_from_query(Some("full&thread=thrd_9")).as_deref(),
            Some("thrd_9")
        );
    }
}
