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

/// Bodies and attacker-controlled key strings share one exact 4 MiB budget.
const MAX_ENTRIES: usize = 1024;
pub(super) const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

struct Entry {
    body: Bytes,
    is_dir: bool,
    updated_at_secs: i64,
    /// Insertion order, for oldest-first eviction.
    seq: u64,
}

#[derive(Default)]
struct Store {
    entries: HashMap<Key, Entry>,
    next_seq: u64,
    total_bytes: usize,
}

impl Store {
    fn put(&mut self, key: Key, body: Bytes, is_dir: bool) -> bool {
        let entry_bytes = key.byte_len().saturating_add(body.len());
        if entry_bytes > MAX_TOTAL_BYTES {
            return false;
        }
        if let Some(previous) = self.entries.remove(&key) {
            self.total_bytes = self
                .total_bytes
                .saturating_sub(key.byte_len().saturating_add(previous.body.len()));
        }
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        self.total_bytes += entry_bytes;
        self.entries.insert(
            key,
            Entry {
                body,
                is_dir,
                updated_at_secs: now_secs(),
                seq,
            },
        );
        while self.entries.len() > MAX_ENTRIES || self.total_bytes > MAX_TOTAL_BYTES {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.seq)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.total_bytes = self
                    .total_bytes
                    .saturating_sub(oldest.byte_len().saturating_add(entry.body.len()));
            }
        }
        true
    }

    fn remove(&mut self, key: &Key) {
        if let Some(entry) = self.entries.remove(key) {
            self.total_bytes = self
                .total_bytes
                .saturating_sub(key.byte_len().saturating_add(entry.body.len()));
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Key {
    account_id: String,
    org: String,
    volume: String,
    path: String,
}

impl Key {
    fn byte_len(&self) -> usize {
        self.account_id
            .len()
            .saturating_add(self.org.len())
            .saturating_add(self.volume.len())
            .saturating_add(self.path.len())
    }
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

/// Namespaced so neither accounts nor volumes can alias each other's
/// sidecars. `account_id` is the opaque AccountStorage directory digest,
/// never the upstream subject/storage key.
fn key(account_id: &str, org: &str, volume: &str, path: &str) -> Key {
    Key {
        account_id: account_id.to_string(),
        org: org.to_string(),
        volume: volume.to_string(),
        path: path.to_string(),
    }
}

/// Record a sidecar write. Replaces any previous body at the same path.
pub fn put(
    account_id: &str,
    org: &str,
    volume: &str,
    path: &str,
    body: Bytes,
    is_dir: bool,
) -> bool {
    lock().put(key(account_id, org, volume, path), body, is_dir)
}

/// The stored body, for `GET`.
pub fn get(account_id: &str, org: &str, volume: &str, path: &str) -> Option<Bytes> {
    lock()
        .entries
        .get(&key(account_id, org, volume, path))
        .map(|e| e.body.clone())
}

/// A node describing the sidecar, for `PROPFIND`/`HEAD` — this is what makes
/// rclone's post-upload confirming read succeed.
pub fn stat(account_id: &str, org: &str, volume: &str, path: &str) -> Option<OrgFsNode> {
    let store = lock();
    let entry = store.entries.get(&key(account_id, org, volume, path))?;
    Some(OrgFsNode {
        path: path.to_string(),
        is_dir: entry.is_dir,
        size: entry.body.len() as u64,
        updated_at_secs: entry.updated_at_secs,
    })
}

/// Forget a sidecar, for `DELETE` and for the source of a `MOVE`.
pub fn remove(account_id: &str, org: &str, volume: &str, path: &str) {
    lock().remove(&key(account_id, org, volume, path));
}

/// Drop every shadow entry owned by an account when its identity scope is
/// retired. Besides releasing memory, this prevents a later session from
/// confirming a sidecar written under a previous account generation.
pub fn purge_account(account_id: &str) {
    let mut store = lock();
    store.entries.retain(|key, _| key.account_id != account_id);
    store.total_bytes = store
        .entries
        .iter()
        .map(|(key, entry)| key.byte_len().saturating_add(entry.body.len()))
        .sum();
}

fn now_secs() -> i64 {
    crate::time_util::now_unix_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique per test: the store is process-global, and the suite is parallel.
    fn vol(tag: &str) -> (String, String, String) {
        (
            format!("account-{tag}"),
            format!("org-{tag}"),
            format!("vol-{tag}"),
        )
    }

    #[test]
    fn a_written_sidecar_reads_back() {
        let (a, o, v) = vol("readback");
        put(&a, &o, &v, "d/._a.txt", Bytes::from_static(b"xattr"), false);

        assert_eq!(get(&a, &o, &v, "d/._a.txt").as_deref(), Some(&b"xattr"[..]));
        let node = stat(&a, &o, &v, "d/._a.txt").expect("stat");
        assert_eq!(node.size, 5);
        assert!(!node.is_dir);
        assert_eq!(node.path, "d/._a.txt");
    }

    #[test]
    fn an_absent_sidecar_is_none_so_the_caller_can_404() {
        let (a, o, v) = vol("absent");
        assert!(get(&a, &o, &v, "._nope").is_none());
        assert!(stat(&a, &o, &v, "._nope").is_none());
    }

    #[test]
    fn remove_forgets_it() {
        let (a, o, v) = vol("remove");
        put(&a, &o, &v, "._x", Bytes::from_static(b"1"), false);
        remove(&a, &o, &v, "._x");
        assert!(stat(&a, &o, &v, "._x").is_none());
    }

    /// Two volumes must not see each other's sidecars.
    #[test]
    fn volumes_are_namespaced() {
        put(
            "account-ns",
            "org-ns",
            "vol-a",
            "._same",
            Bytes::from_static(b"a"),
            false,
        );
        put(
            "account-ns",
            "org-ns",
            "vol-b",
            "._same",
            Bytes::from_static(b"bb"),
            false,
        );

        assert_eq!(
            stat("account-ns", "org-ns", "vol-a", "._same")
                .unwrap()
                .size,
            1
        );
        assert_eq!(
            stat("account-ns", "org-ns", "vol-b", "._same")
                .unwrap()
                .size,
            2
        );
    }

    #[test]
    fn accounts_are_namespaced_and_can_be_purged_independently() {
        put(
            "account-a",
            "org",
            "home",
            "._same",
            Bytes::from_static(b"a"),
            false,
        );
        put(
            "account-b",
            "org",
            "home",
            "._same",
            Bytes::from_static(b"bb"),
            false,
        );

        assert_eq!(
            get("account-a", "org", "home", "._same").as_deref(),
            Some(&b"a"[..])
        );
        assert_eq!(
            get("account-b", "org", "home", "._same").as_deref(),
            Some(&b"bb"[..])
        );

        purge_account("account-a");
        assert!(get("account-a", "org", "home", "._same").is_none());
        assert_eq!(
            get("account-b", "org", "home", "._same").as_deref(),
            Some(&b"bb"[..])
        );
    }

    /// The reason the store is bounded: an agent can write forever.
    #[test]
    fn the_store_is_bounded_and_evicts_oldest_first() {
        let (a, o, v) = vol("bound");
        for i in 0..(MAX_ENTRIES + 16) {
            put(
                &a,
                &o,
                &v,
                &format!("._f{i}"),
                Bytes::from_static(b"x"),
                false,
            );
        }
        // The newest survive; the very first are gone.
        assert!(stat(&a, &o, &v, &format!("._f{}", MAX_ENTRIES + 15)).is_some());
        assert!(stat(&a, &o, &v, "._f0").is_none());

        let held = lock()
            .entries
            .keys()
            .filter(|k| k.account_id == a && k.org == o && k.volume == v)
            .count();
        assert!(held <= MAX_ENTRIES, "held {held} entries");
    }

    #[test]
    fn a_local_store_caps_total_bytes_and_rejects_one_oversized_sidecar() {
        let mut store = Store::default();
        let make_key = |path: &str| key("account-cap", "org", "home", path);
        assert!(store.put(
            make_key("._first"),
            Bytes::from(vec![1; MAX_TOTAL_BYTES / 2 + 1]),
            false,
        ));
        assert!(store.put(
            make_key("._second"),
            Bytes::from(vec![2; MAX_TOTAL_BYTES / 2 + 1]),
            false,
        ));
        assert!(!store.entries.contains_key(&make_key("._first")));
        assert!(store.entries.contains_key(&make_key("._second")));
        assert!(store.total_bytes <= MAX_TOTAL_BYTES);

        assert!(!store.put(
            make_key("._oversized"),
            Bytes::from(vec![3; MAX_TOTAL_BYTES + 1]),
            false,
        ));
        assert!(!store.entries.contains_key(&make_key("._oversized")));

        let oversized_key = make_key(&"x".repeat(MAX_TOTAL_BYTES));
        assert!(!store.put(oversized_key.clone(), Bytes::new(), false));
        assert!(!store.entries.contains_key(&oversized_key));
    }
}
