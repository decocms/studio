//! Per-handle git-sandbox workdir manager — see
//! the native Git-sandbox contract for the target design this
//! module implements.
//!
//! `local-api` boots with exactly ONE `AppState.repo_dir`/`AppState.setup`
//! pair (the "plain" path: a user opens an already-checked-out project
//! folder, no clone involved — see `crate::setup`'s own module doc). That
//! path is UNCHANGED by this module.
//!
//! For a git-BACKED virtual MCP (a chat pinned to a `{cloneUrl, branch}`),
//! prod (`bunx decocms link`) gives every `(virtualMcpId, branch)` pair its
//! OWN full clone directory, keyed by a derived `handle` — see the design
//! doc's "Prod contract" section. [`SandboxManager`] is that same idea,
//! adapted to run in-process (no per-handle daemon subprocess, no
//! `<handle>.localhost` routing — both dropped for the reasons the design
//! doc's "Desktop adaptation" section explains): one [`Sandbox`] per handle,
//! each with its OWN `workdir`, `ConfigStore`, `TaskRegistry`, `Broadcaster`,
//! and `SetupOrchestrator` — the EXISTING clone -> install -> start pipeline
//! (`crate::setup`), just instantiated per-workdir instead of once globally.
//!
//! Setup and intercepted sandbox-lifecycle callers invoke
//! [`SandboxManager::ensure`] with a [`GitSandboxConfig`] derived from the
//! selected workspace, then use the returned [`Sandbox::workdir`] as the
//! terminal's spawn `cwd` instead of the single global `state.repo_dir`.
//! `routes/proxy.rs` reads a [`Sandbox`]'s own `setup`/`config` to resolve
//! the SNIFFED dev port for that specific handle (see that file's module
//! doc for the header-based routing convention).

/// Directory under `<app_root>` holding one directory per sandbox.
///
/// Named for what these actually are: `git worktree`s of the shared bare
/// mirror in `repos/`. A constant rather than a literal repeated at every
/// call site, because a directory name spelled twenty-one different places is
/// exactly the kind of thing that drifts.
pub(crate) const WORKTREES_DIR: &str = "worktrees";

/// The traversal-safety core every handle validator shares: a handle is a
/// multi-segment RELATIVE path under the worktrees root, so no segment may be
/// empty, `.` or `..`, and no `\` may appear anywhere. Layers with stricter
/// needs (persist's sidecar round-trip adds a charset allowlist and a length
/// cap) apply their extras ON TOP — the extras differ per layer, this
/// property must not.
pub(crate) fn handle_is_path_safe(handle: &str) -> bool {
    !handle.is_empty()
        && !handle.contains('\\')
        && handle
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

pub(crate) mod account_storage;
pub(crate) mod dev_port;
pub mod manager;
pub mod org_mount;
pub mod org_prompt;
pub mod org_view;
pub(crate) mod persist;
pub(crate) mod registry;
pub mod repo_store;
pub mod target;

pub use manager::{GitSandboxConfig, SandboxManager};
pub use target::SandboxTarget;

/// Request header a caller sets to route a per-handle sandbox request (preview
/// proxy, tasks, scripts, setup) at a SPECIFIC git-sandbox handle instead of
/// the process-global path — see `routes/proxy.rs`'s module doc's "Dev-port
/// resolution" section and [`crate::sandbox::target`]. The TS side echoes this
/// exact header name; keep it the ONE source of truth.
pub const SANDBOX_HANDLE_HEADER: &str = "x-decocms-sandbox-handle";

/// Extracts the sandbox handle from [`SANDBOX_HANDLE_HEADER`] on a request, if
/// present and valid UTF-8 — the header-side counterpart to `events.rs`'s
/// `?handle=` query param. Empty values are treated as absent so a caller that
/// sends an empty header behaves like a headerless request.
pub fn handle_from_headers(headers: &axum::http::HeaderMap) -> Option<&str> {
    headers
        .get(SANDBOX_HANDLE_HEADER)
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
}

/// The branch a sandbox lands on when the caller names none.
///
/// `staging`, deliberately NOT the repository's default branch: a worktree on
/// `main`/`master` is a dead end by this app's own rules — `git.rs` refuses
/// every push to a protected branch, so a sandbox there can accumulate work
/// it can never publish, and the UI renders a branch chip ("main") that looks
/// like an ordinary workspace but isn't one.
pub const DEFAULT_BRANCH: &str = "staging";

/// The ONE branch-normalization rule, applied wherever a branch enters
/// sandbox resolution: missing and empty collapse to [`DEFAULT_BRANCH`], and
/// so do `main`/`master` — being on a protected branch is IMPOSSIBLE by
/// construction, not merely refused at push time. A thread that persisted
/// `main` before this rule existed resolves to the staging sandbox from now
/// on; its old worktree simply stops being addressed.
///
/// Static by design: the protected set in `git.rs` also contains the REMOTE
/// default branch, resolved per repository, but at normalization time there
/// is no repository yet. A repo whose default IS `staging` therefore still
/// lands on it — the push guard remains the backstop for that case.
pub fn normalize_branch(branch: Option<&str>) -> &str {
    let Some(trimmed) = branch.map(str::trim).filter(|value| !value.is_empty()) else {
        return DEFAULT_BRANCH;
    };
    // Case-INSENSITIVE. `slugify_branch` folds case on the way to a handle, so
    // `MAIN` produced a worktree directory named `.../main`; on the
    // case-insensitive volumes macOS ships by default git then resolves it to
    // the protected ref itself. A rule described as "impossible by
    // construction" must not fall to one shift key.
    if PROTECTED_BRANCHES
        .iter()
        .any(|protected| trimmed.eq_ignore_ascii_case(protected))
    {
        return DEFAULT_BRANCH;
    }
    trimmed
}

/// Branches a sandbox may never occupy — kept here, beside the normalization
/// that enforces it, so the push guard in `routes::git` and this rule cannot
/// drift apart. `routes::git` additionally protects the REMOTE default branch,
/// which is only knowable per repository.
pub const PROTECTED_BRANCHES: [&str; 2] = ["main", "master"];

/// Synthetic branches (`"ephemeral"`, `"thread:<id>"`) are sandbox routing
/// keys, not real git refs — they must never be checked out or shown to a
/// user as a branch. Byte-parity with
/// `packages/shared/src/is-synthetic-branch.ts` (itself mirroring
/// `packages/sandbox/daemon-go/internal/gitx/refname.go`): this predicate is a
/// cross-language wire contract, and a second Rust copy is how one side ends
/// up checking out a routing key the other side still treats as synthetic.
pub(crate) fn is_synthetic_branch(branch: &str) -> bool {
    branch == "ephemeral" || branch.starts_with("thread:")
}

/// Parse the tenant-authority component of a reserved `thread:` routing key.
///
/// This is deliberately stricter than [`is_synthetic_branch`]. The latter is
/// a cross-language git-routing predicate and must classify even malformed
/// `thread:` prefixes as non-git refs. Authority boundaries need a complete
/// identity: `thread:<id>` and `thread:<id>/<suffix>` are accepted only when
/// the complete reserved ref and both path segments obey the same bounded,
/// Git-safe vocabulary used by every authority caller.
pub(crate) fn synthetic_thread_id(branch: &str) -> Result<Option<&str>, &'static str> {
    let Some(path) = branch.strip_prefix("thread:") else {
        return Ok(None);
    };
    if branch.len() > 255 {
        return Err("thread-backed sandbox branch exceeds 255 bytes");
    }
    let (thread_id, suffix) = match path.split_once('/') {
        Some((thread_id, suffix)) => (thread_id, Some(suffix)),
        None => (path, None),
    };
    if suffix.is_some_and(|suffix| suffix.contains('/')) {
        return Err("thread-backed sandbox branch has too many path segments");
    }
    validate_synthetic_thread_segment(
        thread_id,
        "thread-backed sandbox branch is missing its thread id",
    )?;
    if let Some(suffix) = suffix {
        validate_synthetic_thread_segment(
            suffix,
            "thread-backed sandbox branch has an empty suffix",
        )?;
    }
    Ok(Some(thread_id))
}

/// Strict ingress wrapper for branch values supplied by a request. Trimming
/// remains part of ordinary branch normalization, but a whitespace-wrapped
/// reserved key must not be persisted in a noncanonical form. Legacy rows are
/// handled separately by normalizing before calling [`synthetic_thread_id`]
/// on launch.
pub(crate) fn synthetic_thread_id_from_input(branch: &str) -> Result<Option<&str>, &'static str> {
    let trimmed = branch.trim();
    if trimmed != branch && trimmed.starts_with("thread:") {
        return Err("thread-backed sandbox branch has leading or trailing whitespace");
    }
    synthetic_thread_id(normalize_branch(Some(branch)))
}

fn validate_synthetic_thread_segment(
    segment: &str,
    empty_error: &'static str,
) -> Result<(), &'static str> {
    if segment.is_empty() {
        return Err(empty_error);
    }
    if segment == "." || segment == ".." {
        return Err("thread-backed sandbox branch contains a reserved path segment");
    }
    if !segment
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
    {
        return Err("thread-backed sandbox branch segments must start with an alphanumeric byte");
    }
    if !segment
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("thread-backed sandbox branch contains an invalid byte");
    }
    if segment.contains("..") {
        return Err("thread-backed sandbox branch contains two consecutive dots");
    }
    if segment.ends_with(".lock") {
        return Err("thread-backed sandbox branch segment ends with .lock");
    }
    Ok(())
}

/// Longest DNS label the preview host may use. 63 is the protocol limit.
const MAX_PREVIEW_LABEL: usize = 63;

/// The single DNS label a sandbox's preview is served from:
/// `<label>.<control host>`.
///
/// A handle CANNOT be used directly. It is `<owner>/<repo>/<branch>`, and
/// interpolating a value with slashes into a hostname produced
/// `https://acme/repo/branch.local.studio.decocms.com:PORT/` — which every URL
/// parser reads as host `acme` with the rest as a PATH. (When the handle still
/// carried a host segment this pointed the preview iframe at github.com, which
/// is how it was found.) One label is also what the
/// wildcard certificate covers (`*.local.studio.decocms.com` matches exactly
/// one label) and what keeps each sandbox in its own cookie jar.
///
/// Slug plus a digest of the full handle: the slug keeps the host readable in
/// the URL bar and in logs, and the digest is what actually carries
/// uniqueness — slugging alone maps `a.b/c` and `a/b/c` onto one label, and a
/// silent collision here routes a preview at the wrong sandbox. The slug is
/// truncated from the FRONT so the branch, the part that differs between two
/// sandboxes of one repo, is the part that survives.
#[cfg(test)]
fn preview_label(handle: &str) -> String {
    preview_label_with_identity(handle.as_bytes(), handle)
}

pub(crate) fn preview_label_for_scope(account_scope: &str, handle: &str) -> String {
    let identity = format!(
        "decocms-preview-v2\0{}:{}{}",
        account_scope.len(),
        account_scope,
        handle
    );
    preview_label_with_identity(identity.as_bytes(), handle)
}

fn preview_label_with_identity(identity: &[u8], handle: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(identity);
    let hash: String = digest
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect();

    let mut slug = String::with_capacity(handle.len());
    let mut last_dash = false;
    for ch in handle.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            slug.push(lower);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-');

    // `-<hash>` is always kept; the slug yields whatever room is left.
    let room = MAX_PREVIEW_LABEL - hash.len() - 1;
    let kept = if slug.len() > room {
        slug.char_indices()
            .nth(slug.chars().count() - room)
            .map(|(index, _)| &slug[index..])
            .unwrap_or(slug)
    } else {
        slug
    };
    let kept = kept.trim_matches('-');
    if kept.is_empty() {
        format!("s-{hash}")
    } else {
        format!("{kept}-{hash}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HANDLE: &str = "deco-sites/faststore-fila/gimenes-akw515sm";

    /// The regression: a handle contains `/`, so interpolating it as a
    /// subdomain produced a URL whose HOST was the handle's FIRST segment and
    /// whose PATH was everything else — the preview iframe loaded that host
    /// (github.com, back when the handle still carried one) instead of the
    /// sandbox.
    #[test]
    fn the_preview_host_is_one_label_and_not_the_repository_host() {
        let label = preview_label(HANDLE);
        assert!(!label.contains('/'), "{label}");
        assert!(!label.contains('.'), "{label}");
        assert!(!label.is_empty());
        assert!(label.len() <= MAX_PREVIEW_LABEL, "{} chars", label.len());
        assert!(
            label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
            "{label}"
        );
        assert!(!label.starts_with('-') && !label.ends_with('-'), "{label}");

        // The host the browser would actually resolve.
        let host = format!("{label}.local.studio.decocms.com");
        assert!(host.starts_with(&label));
        assert_eq!(host.split('.').next(), Some(label.as_str()));
    }

    /// Slugging alone maps these onto one label, and a collision routes a
    /// preview at the wrong sandbox — which is why the digest is not optional.
    #[test]
    fn handles_that_slug_alike_still_get_distinct_labels() {
        let a = preview_label("acme/my.site/main");
        let b = preview_label("acme/my-site/main");
        assert_ne!(a, b, "slug-only collision");
        assert_ne!(
            preview_label("acme/repo/feat-a"),
            preview_label("acme/repo/feat-b")
        );
    }

    /// A long handle must still yield a legal label, and must keep the branch
    /// — the part that distinguishes two sandboxes of the same repository.
    #[test]
    fn a_long_handle_is_truncated_from_the_front_and_stays_legal() {
        let long = format!(
            "github.com/{}/{}/my-feature-branch",
            "o".repeat(60),
            "r".repeat(60)
        );
        let label = preview_label(&long);
        assert!(label.len() <= MAX_PREVIEW_LABEL, "{} chars", label.len());
        assert!(label.contains("my-feature-branch"), "{label}");
        assert!(!label.starts_with('-') && !label.ends_with('-'), "{label}");
    }

    #[test]
    fn the_label_is_stable_for_one_handle() {
        assert_eq!(preview_label(HANDLE), preview_label(HANDLE));
    }

    /// Mirrors `packages/shared/src/is-synthetic-branch.test.ts` case for
    /// case — the two languages must agree on what a routing key is, or one
    /// side checks out a ref the other refuses to show.
    #[test]
    fn is_synthetic_branch_matches_the_shared_ts_contract() {
        // The literal `ephemeral` branch.
        assert!(is_synthetic_branch("ephemeral"));
        // Any `thread:`-prefixed branch, including the bare prefix.
        assert!(is_synthetic_branch("thread:abc-123"));
        assert!(is_synthetic_branch("thread:"));
        // Real branch names.
        assert!(!is_synthetic_branch("main"));
        assert!(!is_synthetic_branch("deco/swift-glade"));
        assert!(!is_synthetic_branch("feature/x"));
        // No substrings or case variants.
        assert!(!is_synthetic_branch("ephemeral-foo"));
        assert!(!is_synthetic_branch("Ephemeral"));
        assert!(!is_synthetic_branch("my-thread:1"));
    }

    #[test]
    fn synthetic_thread_parser_requires_a_complete_reserved_identity() {
        assert_eq!(
            synthetic_thread_id("thread:chat-1").unwrap(),
            Some("chat-1")
        );
        assert_eq!(
            synthetic_thread_id("thread:chat-1/connection-2").unwrap(),
            Some("chat-1")
        );
        assert_eq!(
            synthetic_thread_id("thread:A0._-/9x._-").unwrap(),
            Some("A0._-")
        );
        assert_eq!(synthetic_thread_id("feature/thread:chat-1").unwrap(), None);
        assert!(synthetic_thread_id_from_input(" thread:chat-1 ").is_err());
        assert_eq!(
            synthetic_thread_id_from_input(" feature/chat-1 ").unwrap(),
            None
        );
        assert!(synthetic_thread_id("thread:").is_err());
        assert!(synthetic_thread_id("thread:/connection-2").is_err());
        assert!(synthetic_thread_id("thread:chat-1/").is_err());
        let longest_valid_id = "a".repeat(248);
        assert_eq!(
            synthetic_thread_id(&format!("thread:{longest_valid_id}")).unwrap(),
            Some(longest_valid_id.as_str())
        );
        for branch in [
            format!("thread:{}", "a".repeat(249)),
            "thread:_chat".to_string(),
            "thread:-chat".to_string(),
            "thread:.chat".to_string(),
            "thread:.".to_string(),
            "thread:..".to_string(),
            "thread:chat/_connection".to_string(),
            "thread:chat/connection/extra".to_string(),
            "thread:chat id".to_string(),
            "thread:chat@id".to_string(),
            "thread:chat..id".to_string(),
            "thread:chat.lock".to_string(),
            "thread:chat/.".to_string(),
            "thread:chat/..".to_string(),
            "thread:chat/connection..2".to_string(),
            "thread:chat/connection.lock".to_string(),
        ] {
            assert!(
                synthetic_thread_id(&branch).is_err(),
                "invalid reserved branch was accepted: {branch}"
            );
        }
    }
}
