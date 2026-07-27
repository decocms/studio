//! The organization-filesystem block injected into a desktop harness's system
//! prompt. P4 of `apps/native/docs/org-fs-plan.md`.
//!
//! Adapted from the cluster's `buildOrgFilesystemPrompt`
//! (`apps/api/src/api/routes/decopilot/constants.ts`), which is consumed by the
//! decopilot harness only — the desktop CLIs (`claude-code`, `codex`) receive
//! no system prompt at all without this.
//!
//! ## Why it cannot be reused verbatim
//!
//! Three things differ on the desktop, and each one would be a lie if the
//! cluster's wording were copied across:
//!
//! 1. **Paths are absolute.** The agent's cwd is the git worktree, and `org`
//!    is its SIBLING, not a child — a relative `org/...` does not resolve.
//! 2. **Uploads and outputs are thread-scoped subdirectories** of an org-wide
//!    volume (`uploads/<thread>/`), where the cluster hands the agent a
//!    per-run symlink at the bare path `org/upload/`. Naming the exact
//!    directory here is what replaces that symlink — which is why the desktop
//!    needs no per-dispatch relinking and has no race between concurrent runs.
//! 3. **Nothing is auto-loaded.** The cluster promises the memory files "appear
//!    in the `<organization-memory>` block"; the desktop has no such
//!    mechanism, so this block says to READ them instead of claiming they are
//!    already in context. Telling an agent its memory is loaded when it is not
//!    is worse than saying nothing.

use std::path::Path;

/// Build the `<organization-filesystem>` block for one dispatch.
///
/// `org_dir` is the sandbox's own view directory (`<sandbox>/org`), whose
/// entries are symlinks into the shared per-org mounts.
pub fn build(org_dir: &Path, thread_id: &str, user_id: Option<&str>) -> String {
    let org = org_dir.display();
    let user = user_id.unwrap_or("<your-user-id>");
    format!(
        "<organization-filesystem>\n\
         The organization filesystem is mounted on this machine at `{org}/`. These are \
         absolute paths — your working directory is the git repository, and the \
         organization filesystem is beside it, so relative `org/...` paths will not resolve.\n\
         - `{org}/home/` — the org's shared home folder, editable and shared across every \
         agent, member, and run. Organize it freely with subfolders. Consult it only when a \
         task needs background you don't already have (past decisions, preferences, project \
         facts, gotchas) — then read it first. Do NOT browse it in response to greetings, \
         small talk, or questions you can answer directly. Record durable knowledge here as \
         you learn it; prefer small focused markdown files over one big log, and update stale \
         notes instead of appending duplicates.\n\
         - `{org}/home/MEMORY.md` — the ORGANIZATION memory index: durable facts shared with \
         everyone in this org. Read it when you need that background; it is not loaded for you.\n\
         - `{org}/home/users/{user}/MEMORY.md` — your USER memory index: facts and preferences \
         specific to the current user, not shared with other members. Also read on demand.\n\
         Keep both indexes concise — a curated list of durable facts and one-line pointers to \
         deeper notes elsewhere in the home folder. When you learn something worth remembering \
         across sessions, edit the matching file (user-specific → user memory; org-wide → \
         organization memory); update existing lines instead of appending duplicates.\n\
         - `{org}/public/<set>/` — curated read-only skill sets. This directory is mounted \
         read-only; writes to it will fail.\n\
         - `{org}/uploads/{thread_id}/` — files the user attached to THIS conversation are \
         already here; read them directly (no copy step needed).\n\
         - `{org}/outputs/{thread_id}/` — write final deliverables here; they are shared back \
         to the organization under this conversation's folder.\n\
         </organization-filesystem>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        build(
            Path::new("/data/sandboxes/h1/org"),
            "thread-42",
            Some("user-7"),
        )
    }

    /// The whole point of the desktop variant: a relative `org/...` does not
    /// resolve from the agent's cwd, so every path must be absolute.
    #[test]
    fn every_path_is_absolute() {
        let prompt = sample();
        for path in [
            "/data/sandboxes/h1/org/home/",
            "/data/sandboxes/h1/org/home/MEMORY.md",
            "/data/sandboxes/h1/org/public/<set>/",
            "/data/sandboxes/h1/org/uploads/thread-42/",
            "/data/sandboxes/h1/org/outputs/thread-42/",
        ] {
            assert!(prompt.contains(path), "missing {path}");
        }
        // No bare relative reference that would silently fail to resolve.
        assert!(!prompt.contains("`org/home"), "leaked a relative org path");
        assert!(
            !prompt.contains("`org/upload"),
            "leaked a relative org path"
        );
    }

    /// Uploads/outputs are thread-scoped: naming the exact directory is what
    /// replaces the cluster's per-run symlink.
    #[test]
    fn uploads_and_outputs_are_scoped_to_this_thread() {
        let other = build(Path::new("/data/sandboxes/h1/org"), "thread-99", None);
        assert!(other.contains("/org/uploads/thread-99/"));
        assert!(!other.contains("thread-42"));
    }

    #[test]
    fn the_user_memory_path_carries_the_user_id() {
        assert!(sample().contains("/org/home/users/user-7/MEMORY.md"));
        let anon = build(Path::new("/o"), "t", None);
        assert!(anon.contains("/o/home/users/<your-user-id>/MEMORY.md"));
    }

    /// The desktop auto-loads nothing, so the block must not claim otherwise —
    /// an agent told its memory is already in context will not go read it.
    #[test]
    fn never_claims_memory_is_already_loaded() {
        let prompt = sample().to_lowercase();
        for lie in [
            "auto-loaded",
            "appear in the <organization-memory>",
            "shown in the <user-memory>",
        ] {
            assert!(!prompt.contains(lie), "claimed {lie:?}");
        }
    }

    #[test]
    fn says_public_is_read_only() {
        assert!(sample().contains("read-only"));
    }
}
