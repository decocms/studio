//! The ONE home for dev-server port policy.
//!
//! Three call sites decide ports, and they must agree or the preview breaks
//! in the quietest possible way — a healthy server on a port nothing targets:
//!
//! * the setup orchestrator, spawning the dev script at provision time
//!   (`setup/dev.rs`), sets the child's `PORT` from [`resolve`];
//! * the UI's run button (`POST /_sandbox/exec/:name`, `routes/scripts.rs`)
//!   respawns the same script and defaults `PORT` from [`resolve`] too;
//! * the preview proxy (`routes/proxy.rs`) targets the lifecycle-announced
//!   port while a run is live, and otherwise falls back through [`assigned`]
//!   before the config's static value.
//!
//! Policy, in preference order: the port this sandbox already holds (the
//! per-process assignment map, seeded from the persisted
//! [`crate::sandbox::persist::DevProcessRecord`] on cold start), then the
//! config's `application.port`, then a probed ephemeral port. A sandbox keeps
//! its port across restarts so its URL stays stable, and a port promised to
//! one sandbox is never handed to another.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The directory a sandbox's port identity is keyed by — the parent of its
/// repo workdir (where `dev-process.json` also lives), or the workdir itself
/// for the global path, which has no enclosing sandbox directory.
pub(crate) fn sandbox_root_for(repo_dir: &Path) -> PathBuf {
    repo_dir
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| repo_dir.to_path_buf())
}

/// The VM config's `application.port` — always a SEED for allocation, never
/// a value handed to a child or a proxy directly.
pub(crate) fn configured_port(config: &Value) -> Option<u16> {
    config
        .get("application")
        .and_then(|application| application.get("port"))
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
}

/// The `PORT` a process serving this sandbox should bind.
///
/// Prefers the port the sandbox already holds ([`assigned`], which consults
/// the persisted record on cold start), then the configured seed, then an
/// ephemeral allocation. `None` means every candidate failed, in which case
/// `PORT` is best left unset so the dev server picks for itself.
pub(crate) fn resolve(sandbox_root: &Path, configured: Option<u16>) -> Option<u16> {
    let held = assigned(sandbox_root);
    allocate(sandbox_root, held.or(configured))
}

/// The port this sandbox holds, without allocating one.
///
/// A map miss falls back to the persisted [`DevProcessRecord::port`] — the
/// port a PREVIOUS run of this app told the sandbox's dev server to bind —
/// and claims it in the map, so the answer is stable from then on and the
/// port cannot be handed to another sandbox.
///
/// [`DevProcessRecord::port`]: crate::sandbox::persist::DevProcessRecord::port
pub(crate) fn assigned(sandbox_root: &Path) -> Option<u16> {
    let mut assigned = lock_assigned();
    if let Some(port) = assigned.get(sandbox_root) {
        return Some(*port);
    }
    let port = crate::sandbox::persist::read_dev_process(sandbox_root)?.port?;
    assigned.insert(sandbox_root.to_path_buf(), port);
    Some(port)
}

/// Which port each sandbox's dev server was given, for the lifetime of this
/// process.
///
/// Keyed by sandbox so a restart of ONE sandbox reuses its own port instead
/// of drifting to a new one, and so a port already promised to another
/// sandbox is never handed out twice. Bounded by the number of sandboxes,
/// not by how many times they are started.
fn lock_assigned() -> std::sync::MutexGuard<'static, HashMap<PathBuf, u16>> {
    static ASSIGNED: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, u16>>> =
        std::sync::OnceLock::new();
    ASSIGNED
        .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// How many ephemeral candidates to try before giving up and letting the dev
/// server choose (which is the old behaviour, not a failure).
const PORT_ALLOCATION_ATTEMPTS: usize = 16;

/// Whether nothing is listening on `port`.
///
/// Bound on `0.0.0.0` because that is what the child binds (`HOST` /
/// `HOSTNAME` are set to `0.0.0.0` by both spawn paths), so a probe of
/// loopback alone would miss a conflicting listener on another interface.
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("0.0.0.0", port)).is_ok()
}

/// A dev-server port for one sandbox: `preferred` when it is genuinely free,
/// else a fresh ephemeral one.
///
/// The probe closes its socket before the child binds, so two sandboxes
/// starting concurrently could still race for the same number; the assignment
/// map is what actually prevents that, and the probe only rules out ports
/// held by processes outside this app.
fn allocate(sandbox_root: &Path, preferred: Option<u16>) -> Option<u16> {
    let mut assigned = lock_assigned();
    let promised_elsewhere = |assigned: &HashMap<PathBuf, u16>, port: u16| {
        assigned
            .iter()
            .any(|(root, taken)| *taken == port && root != sandbox_root)
    };

    if let Some(port) = preferred {
        // A port this sandbox already holds reads as "in use" to the probe —
        // by its OWN dev server, which is about to be replaced — so keep it
        // rather than drift away from a URL that is still correct.
        let ours = assigned.get(sandbox_root) == Some(&port);
        if !promised_elsewhere(&assigned, port) && (ours || port_is_free(port)) {
            assigned.insert(sandbox_root.to_path_buf(), port);
            return Some(port);
        }
    }

    for _ in 0..PORT_ALLOCATION_ATTEMPTS {
        let Ok(probe) = std::net::TcpListener::bind(("0.0.0.0", 0)) else {
            continue;
        };
        let Ok(port) = probe.local_addr().map(|address| address.port()) else {
            continue;
        };
        drop(probe);
        if !promised_elsewhere(&assigned, port) {
            assigned.insert(sandbox_root.to_path_buf(), port);
            return Some(port);
        }
    }
    tracing::warn!(
        ?sandbox_root,
        "could not allocate a dev server port; letting the dev server choose"
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two sandboxes of one repository must never be told to bind the same
    /// port — that collision is what made them drift across 3000..3003 and
    /// left the proxy guessing which server belonged to which worktree.
    #[test]
    fn each_sandbox_gets_its_own_port_and_keeps_it_across_restarts() {
        let root = tempfile::tempdir().unwrap();
        let one = root.path().join("sandbox-one");
        let two = root.path().join("sandbox-two");

        // Both ask for the same configured port; only the first can have it.
        let first = allocate(&one, Some(45771)).unwrap();
        let second = allocate(&two, Some(45771)).unwrap();
        assert_ne!(first, second);

        // Restarting a sandbox reuses ITS port, even though its own dev server
        // is still holding the socket at that moment.
        let held = std::net::TcpListener::bind(("0.0.0.0", first)).ok();
        assert_eq!(allocate(&one, Some(first)), Some(first));
        drop(held);

        // …but never a port already promised to a different sandbox.
        assert_ne!(allocate(&two, Some(first)), Some(first));

        // With nothing to prefer, allocation still succeeds and stays distinct.
        let three = root.path().join("sandbox-three");
        let fresh = allocate(&three, None).unwrap();
        assert!(fresh != first && fresh != second);
    }

    #[test]
    fn a_port_something_else_is_listening_on_is_never_handed_out() {
        let root = tempfile::tempdir().unwrap();
        let occupied = std::net::TcpListener::bind(("0.0.0.0", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(!port_is_free(port));
        assert_ne!(
            allocate(&root.path().join("sandbox"), Some(port)),
            Some(port)
        );
        drop(occupied);
    }

    #[test]
    fn resolve_prefers_the_held_port_over_a_changed_config() {
        let root = tempfile::tempdir().unwrap();
        let one = root.path().join("held");
        let first = resolve(&one, None).unwrap();
        assert_eq!(
            resolve(&one, Some(first.wrapping_add(1).max(1024))),
            Some(first),
            "the sandbox's URL stays stable even when the config seed moves"
        );
    }

    #[test]
    fn configured_port_reads_application_port() {
        let config = serde_json::json!({ "application": { "port": 4000 } });
        assert_eq!(configured_port(&config), Some(4000));
        assert_eq!(configured_port(&serde_json::json!({})), None);
        assert_eq!(
            configured_port(&serde_json::json!({ "application": { "port": 700000 } })),
            None,
            "an out-of-range port is a config error, not a u16"
        );
    }

    #[test]
    fn sandbox_root_is_the_repo_dirs_parent() {
        let repo = Path::new("/data/sandboxes/h1/repo");
        assert_eq!(sandbox_root_for(repo), Path::new("/data/sandboxes/h1"));
        assert_eq!(sandbox_root_for(Path::new("/")), Path::new("/"));
    }
}
