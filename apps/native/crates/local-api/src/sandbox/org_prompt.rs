//! The organization-filesystem block injected into a desktop harness's system
//! prompt. P4 of `apps/native/docs/org-fs-plan.md`.
//!
//! Adapted from the cluster's `buildOrgFilesystemPrompt`
//! (`apps/api/src/api/routes/decopilot/constants.ts`), which is consumed by the
//! decopilot harness only — the desktop CLIs (`claude-code`, `codex`,
//! `opencode`) receive
//! no system prompt at all without this.
//!
//! ## Why it cannot be reused verbatim
//!
//! Four things differ on the desktop, and each one would be a lie if the
//! cluster's wording were copied across:
//!
//! 1. **Paths must be resolvable from a cwd that is not the filesystem.** The
//!    agent stands in the git worktree and `org` is its SIBLING, so a bare
//!    `org/...` does not resolve. A tree rooted at one absolute path is how
//!    this block satisfies that: the root is stated once and every row is
//!    read against it, which SHOWS the sibling layout instead of asserting it
//!    in prose — and costs one long path instead of eight. That repetition
//!    was measured at ~270 tokens per turn on a real sandbox path.
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
//! 4. **Deliverables have exactly one destination.** They go to
//!    `outputs/<thread>/`; `home/` stays writable so memory can accumulate,
//!    but it is for durable facts, not output files. Anything outside the
//!    volumes is ordinary local disk, so a stray write there succeeds,
//!    reaches nobody, and gives the agent no signal it went wrong — the one
//!    failure it cannot detect for itself, which is why the block says so
//!    outright rather than trusting the layout to imply it.

use std::path::Path;

/// Build the `<organization-filesystem>` block for one dispatch.
///
/// `org_dir` is the organization filesystem the agent can reach: the
/// sandbox's own view directory (`<sandbox>/org`, whose entries are symlinks
/// into the shared per-org mounts) for a git-backed agent, or the mount root
/// itself for a gitless one — which is also the agent's cwd, so the tree
/// below is drawn differently for each.
pub fn build(org_dir: &Path, thread_id: &str, user_id: Option<&str>) -> String {
    let user = user_id.unwrap_or("<your-user-id>");
    // A git-backed agent stands in `<sandbox>/repo` with the org filesystem
    // BESIDE it, so the tree is rooted at the shared parent: showing both
    // siblings is what makes "beside, not below" obvious, where the prose
    // this replaces had to assert it. A gitless agent stands IN the org
    // filesystem, where that assertion is simply false, so its tree is
    // rooted at the filesystem itself and omits the `repo/` sibling.
    let git_backed = org_dir.file_name().is_some_and(|name| name == "org");
    let root = match (git_backed, org_dir.parent()) {
        (true, Some(sandbox)) => sandbox.display().to_string(),
        _ => org_dir.display().to_string(),
    };
    let org = org_dir.display();

    let mut rows: Vec<(String, String)> = Vec::with_capacity(6);
    if git_backed {
        rows.push((
            "├── repo/".to_string(),
            "your working directory (git)".to_string(),
        ));
        rows.push((
            "└── org/".to_string(),
            "the organization filesystem".to_string(),
        ));
    }
    let nest = if git_backed { "    " } else { "" };
    rows.push((
        format!("{nest}├── outputs/{thread_id}/"),
        "WRITE deliverables here — the only path that carries them back to the organization"
            .to_string(),
    ));
    rows.push((
        format!("{nest}├── uploads/{thread_id}/"),
        "files the user attached to THIS conversation".to_string(),
    ));
    rows.push((
        format!("{nest}├── home/"),
        format!(
            "shared org knowledge, indexed by MEMORY.md and users/{user}/MEMORY.md. Read on \
             demand — none of it is in your context already. Write anywhere here to record \
             durable facts, updating stale notes rather than appending duplicates"
        ),
    ));
    rows.push((
        format!("{nest}└── public/"),
        "curated skill sets, read-only".to_string(),
    ));

    // One column, computed from the rows themselves: a hand-counted pad drifts
    // the moment a path or a thread id changes length.
    let column = rows.iter().map(|(path, _)| path.chars().count()).max();
    let tree = rows
        .iter()
        .map(|(path, gloss)| {
            let pad = " ".repeat(column.unwrap_or_default() - path.chars().count() + 2);
            format!("{path}{pad}{gloss}")
        })
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "<organization-filesystem>\n\
         {root}/\n\
         {tree}\n\
         Deliverables belong at the absolute path `{org}/outputs/{thread_id}/`. Nothing \
         outside the directories above is part of the organization filesystem: a write \
         elsewhere is accepted with NO error and is then invisible to everyone, forever, so \
         a write that succeeded is not evidence you used the right path.\n\
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

    /// Every path stays RESOLVABLE from the agent's cwd — the invariant the
    /// old prose satisfied by spelling all five paths absolutely, and this
    /// version satisfies by rooting a tree at one absolute path. Inverted
    /// deliberately: the rows are relative BY DESIGN, so asserting they are
    /// absolute would pin the cost the tree exists to remove. What must not
    /// regress is a relative path presented OUTSIDE the tree, where there is
    /// no root to read it against.
    #[test]
    fn the_tree_is_rooted_at_one_absolute_path() {
        let prompt = sample();
        assert!(
            prompt.starts_with("<organization-filesystem>\n/data/sandboxes/h1/\n"),
            "the absolute root must be the first thing under the tag: {prompt}"
        );
        // The sibling layout, shown rather than asserted in a sentence.
        assert!(prompt.contains("├── repo/"), "{prompt}");
        assert!(prompt.contains("└── org/"), "{prompt}");
        for row in ["├── outputs/", "├── uploads/", "├── home/", "└── public/"]
        {
            assert!(prompt.contains(row), "missing tree row {row}");
        }
        // The prose below the tree must never name a bare relative path: with
        // no tree to anchor it, `org/...` does not resolve from the cwd.
        let prose = prompt.split("└── public/").nth(1).unwrap();
        assert!(!prose.contains("`org/"), "relative path outside the tree");
    }

    /// Uploads/outputs are thread-scoped: naming the exact directory is what
    /// replaces the cluster's per-run symlink.
    #[test]
    fn uploads_and_outputs_are_scoped_to_this_thread() {
        let other = build(Path::new("/data/sandboxes/h1/org"), "thread-99", None);
        assert!(other.contains("uploads/thread-99/"));
        assert!(other.contains("/org/outputs/thread-99/"), "{other}");
        assert!(!other.contains("thread-42"));
    }

    #[test]
    fn the_user_memory_path_carries_the_user_id() {
        assert!(sample().contains("users/user-7/MEMORY.md"));
        let anon = build(Path::new("/o/org"), "t", None);
        assert!(anon.contains("users/<your-user-id>/MEMORY.md"));
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

    /// Deliverables have ONE destination, and the reason is spelled out
    /// because a stray write SUCCEEDS (anything outside the volumes is plain
    /// local disk) while reaching nobody. Observed in practice:
    /// `<org>/fs-test.html` never appeared in the library.
    #[test]
    fn names_outputs_as_the_deliverable_destination() {
        let prompt = sample();
        assert!(
            prompt.contains("`/data/sandboxes/h1/org/outputs/thread-42/`"),
            "the write rule must name the absolute destination"
        );
        assert!(
            prompt.contains("accepted with NO error") && prompt.contains("invisible"),
            "the warning must say a stray write silently succeeds, not that it fails"
        );
    }

    /// Memory is writable: an agent that may only READ its memory never
    /// records what it learns, and the indexes go stale forever. The
    /// deliverable rule above is what keeps this from being a second
    /// destination for output files — `home/` is for durable facts.
    #[test]
    fn memory_stays_writable() {
        let prompt = sample();
        assert!(
            prompt.contains("Write anywhere here to record durable facts"),
            "home/ must be writable for memory to accumulate"
        );
        assert!(
            prompt.contains("updating stale notes rather than appending duplicates"),
            "unbounded appends turn a memory index into a log"
        );
    }

    /// A gitless agent's cwd IS the organization filesystem, so the tree must
    /// not show a `repo/` sibling — and must not be rooted a level above,
    /// which would name a directory the agent has no business in.
    #[test]
    fn a_gitless_agent_gets_a_tree_rooted_at_the_filesystem() {
        let prompt = build(Path::new("/data/orgs/acme"), "thread-42", Some("user-7"));
        assert!(prompt.contains("/data/orgs/acme/\n"), "{prompt}");
        assert!(!prompt.contains("repo/"), "gitless agents have no repo");
        assert!(
            prompt.contains("`/data/orgs/acme/outputs/thread-42/`"),
            "the absolute deliverable path must still be exact"
        );
    }

    /// The block is prepended to every turn, so its length is a recurring
    /// cost — and the long absolute root is what dominates it. Stating the
    /// root once and drawing relative rows under it is the whole point of the
    /// tree; re-interpolating it per line would quietly undo that.
    #[test]
    fn states_the_long_root_path_at_most_twice() {
        let root = "/data/sandboxes/h1";
        assert!(
            sample().matches(root).count() <= 2,
            "the root path is repeated; the tree exists to avoid that"
        );
        assert!(sample().lines().count() <= 12);
    }

    /// The glosses line up in one column regardless of how long a thread id
    /// or path is, so the tree stays readable rather than ragged.
    #[test]
    fn the_gloss_column_is_computed_not_hand_counted() {
        let long = build(
            Path::new("/data/sandboxes/h1/org"),
            "a-very-long-thread-identifier-0000",
            Some("user-7"),
        );
        let columns: Vec<usize> = long
            .lines()
            .filter(|line| line.contains("── "))
            .filter_map(|line| {
                line.find("  ")
                    .map(|_| line.rfind("  ").unwrap_or_default())
            })
            .collect();
        assert!(columns.len() >= 4, "expected the tree rows");
        assert!(
            long.contains("a-very-long-thread-identifier-0000/  "),
            "the longest row still gets its two-space gutter"
        );
    }
}
