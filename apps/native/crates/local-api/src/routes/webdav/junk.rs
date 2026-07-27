//! In-memory shadow store for macOS AppleDouble sidecars.
//!
//! ## Why this exists
//!
//! macOS (Ventura and later) stamps `com.apple.provenance` on every file and
//! directory a non-App-Store process creates. NFS advertises no native extended
//! attributes, so the kernel spills that xattr into a 4096-byte `._<name>`
//! AppleDouble sidecar — for EVERY file and EVERY directory the agent writes.
//! None of it belongs in the organization's filesystem.
//!
//! Simply refusing them does not work, and the obvious refusal is worse than
//! doing nothing. rclone re-reads an object right after uploading it to confirm
//! the write, so answering `PUT` with `201` and the confirming
//! `PROPFIND`/`GET` with `404` puts rclone in an unbounded retry loop:
//!
//! ```text
//! ERROR : adtest3/._h.txt: Failed to copy: object not found
//! ERROR : adtest3/._h.txt: vfs cache: failed to upload try #1, will retry in 2s
//! ERROR : ._adtest3:      vfs cache: failed to upload try #2, will retry in 4s
//! …never converges, and the noise masks real failures.
//! ```
//!
//! So the junk has to look like it was stored without ever being stored. This
//! module keeps the sidecars in memory, where reads can satisfy rclone and
//! nothing reaches `ORG_FS`. Directory listings still omit them, so the user
//! never sees `._` entries in their org filesystem.
//!
//! ## Bounded on purpose
//!
//! An agent can write an unbounded number of files, so this cannot grow
//! without limit. It is capped by entry count and total bytes, evicting oldest
//! first. Losing an evicted sidecar is harmless: the worst case is that the
//! kernel re-derives the xattr and writes it again.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use bytes::Bytes;

use super::dav::OrgFsNode;

/// Sidecars are 4096 bytes each, so this caps the store around 4 MB.
const MAX_ENTRIES: usize = 1024;

struct Entry {
    body: Bytes,
    is_dir: bool,
    updated_at_secs: i64,
    /// Insertion order, for oldest-first eviction.
    seq: u64,
}

#[derive(Default)]
struct Store {
    entries: HashMap<String, Entry>,
    next_seq: u64,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn lock() -> std::sync::MutexGuard<'static, Store> {
    // A poisoned lock still holds usable junk; there is no invariant here
    // worth failing a request over.
    store()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Namespaced so two volumes cannot alias each other's sidecars.
fn key(org: &str, volume: &str, path: &str) -> String {
    format!("{org}\u{0}{volume}\u{0}{path}")
}

/// Record a sidecar write. Replaces any previous body at the same path.
pub fn put(org: &str, volume: &str, path: &str, body: Bytes, is_dir: bool) {
    let mut store = lock();
    let seq = store.next_seq;
    store.next_seq += 1;
    store.entries.insert(
        key(org, volume, path),
        Entry {
            body,
            is_dir,
            updated_at_secs: now_secs(),
            seq,
        },
    );
    // Evict oldest-first until back under the cap.
    while store.entries.len() > MAX_ENTRIES {
        let Some(oldest) = store
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.seq)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        store.entries.remove(&oldest);
    }
}

/// The stored body, for `GET`.
pub fn get(org: &str, volume: &str, path: &str) -> Option<Bytes> {
    lock()
        .entries
        .get(&key(org, volume, path))
        .map(|e| e.body.clone())
}

/// A node describing the sidecar, for `PROPFIND`/`HEAD` — this is what makes
/// rclone's post-upload confirming read succeed.
pub fn stat(org: &str, volume: &str, path: &str) -> Option<OrgFsNode> {
    let store = lock();
    let entry = store.entries.get(&key(org, volume, path))?;
    Some(OrgFsNode {
        path: path.to_string(),
        is_dir: entry.is_dir,
        size: entry.body.len() as u64,
        updated_at_secs: entry.updated_at_secs,
    })
}

/// Forget a sidecar, for `DELETE` and for the source of a `MOVE`.
pub fn remove(org: &str, volume: &str, path: &str) {
    lock().entries.remove(&key(org, volume, path));
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per test: the store is process-global, and the suite is parallel.
    fn vol(tag: &str) -> (String, String) {
        (format!("org-{tag}"), format!("vol-{tag}"))
    }

    #[test]
    fn a_written_sidecar_reads_back() {
        let (o, v) = vol("readback");
        put(&o, &v, "d/._a.txt", Bytes::from_static(b"xattr"), false);

        assert_eq!(get(&o, &v, "d/._a.txt").as_deref(), Some(&b"xattr"[..]));
        let node = stat(&o, &v, "d/._a.txt").expect("stat");
        assert_eq!(node.size, 5);
        assert!(!node.is_dir);
        assert_eq!(node.path, "d/._a.txt");
    }

    #[test]
    fn an_absent_sidecar_is_none_so_the_caller_can_404() {
        let (o, v) = vol("absent");
        assert!(get(&o, &v, "._nope").is_none());
        assert!(stat(&o, &v, "._nope").is_none());
    }

    #[test]
    fn remove_forgets_it() {
        let (o, v) = vol("remove");
        put(&o, &v, "._x", Bytes::from_static(b"1"), false);
        remove(&o, &v, "._x");
        assert!(stat(&o, &v, "._x").is_none());
    }

    /// Two volumes must not see each other's sidecars.
    #[test]
    fn volumes_are_namespaced() {
        put("org-ns", "vol-a", "._same", Bytes::from_static(b"a"), false);
        put(
            "org-ns",
            "vol-b",
            "._same",
            Bytes::from_static(b"bb"),
            false,
        );

        assert_eq!(stat("org-ns", "vol-a", "._same").unwrap().size, 1);
        assert_eq!(stat("org-ns", "vol-b", "._same").unwrap().size, 2);
    }

    /// The reason the store is bounded: an agent can write forever.
    #[test]
    fn the_store_is_bounded_and_evicts_oldest_first() {
        let (o, v) = vol("bound");
        for i in 0..(MAX_ENTRIES + 16) {
            put(&o, &v, &format!("._f{i}"), Bytes::from_static(b"x"), false);
        }
        // The newest survive; the very first are gone.
        assert!(stat(&o, &v, &format!("._f{}", MAX_ENTRIES + 15)).is_some());
        assert!(stat(&o, &v, "._f0").is_none());

        let held = lock()
            .entries
            .keys()
            .filter(|k| k.starts_with(&format!("{o}\u{0}{v}\u{0}")))
            .count();
        assert!(held <= MAX_ENTRIES, "held {held} entries");
    }
}
