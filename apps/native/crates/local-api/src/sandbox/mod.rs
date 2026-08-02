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
//! Callers (`routes/intercept/decopilot.rs::send_message`,
//! `routes/dispatch.rs::build_run_spec`) call [`SandboxManager::ensure`] with
//! a [`GitSandboxConfig`] derived from the dispatch payload's `sandbox`
//! block (decopilot) or `workspace.repo`/`workspace.branch` (the daemon-parity
//! dispatch family), then use the returned [`Sandbox::workdir`] as the
//! harness's spawn `cwd` instead of the single global `state.repo_dir`.
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

/// The one derivation of a sandbox's directory and its repo workdir. The
/// registry persists these paths and `git worktree` registers them, so every
/// site must produce byte-identical joins — a second spelling is a sandbox
/// that can never be found again.
pub(crate) fn worktree_root(app_root: &std::path::Path, handle: &str) -> std::path::PathBuf {
    app_root.join(WORKTREES_DIR).join(handle)
}

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

pub(crate) fn worktree_repo_dir(app_root: &std::path::Path, handle: &str) -> std::path::PathBuf {
    worktree_root(app_root, handle).join("repo")
}

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
/// `packages/sandbox/daemon/constants.ts`): this predicate is a
/// cross-language wire contract, and a second Rust copy is how one side ends
/// up checking out a routing key the other side still treats as synthetic.
pub(crate) fn is_synthetic_branch(branch: &str) -> bool {
    branch == "ephemeral" || branch.starts_with("thread:")
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
pub fn preview_label(handle: &str) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(handle.as_bytes());
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
    let room = MAX_PREVIEW_LABEL
        .saturating_sub(hash.len())
        .saturating_sub(1);
    let kept = if slug.len() > room {
        slug.char_indices()
            .nth(slug.chars().count().saturating_sub(room))
            .and_then(|(index, _)| slug.get(index..))
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
}
