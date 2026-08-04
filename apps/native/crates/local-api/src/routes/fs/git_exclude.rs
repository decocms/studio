//! Port of `packages/sandbox/daemon-go/internal/gitx/exclude.go::ensureGitExclude`.
//! Registers a line in `<repoDir>/.git/info/exclude` so the git family's
//! shutdown-publish hook (`git add -A`) never commits local-api-managed
//! paths (the tool catalog, its endpoint credential file) onto the user's
//! branch. Best-effort: an unwritable `.git` never blocks the caller.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::fs;

use crate::tasks::TaskRegistry;

/// Resolve the worktree-aware exclude path through a hidden generation-owned
/// Git probe. Callers do this before acquiring the filesystem commit lease:
/// Stop can preempt and reap the child, and if Stop wins between resolution
/// and commit the later commit admission rejects the mutation.
pub async fn resolve_git_exclude(tasks: Arc<TaskRegistry>, repo_dir: &Path) -> Option<PathBuf> {
    let repo_dir = repo_dir.to_path_buf();
    crate::routes::git::run_owned_git_probe(tasks, "git exclude-path probe", async move {
        crate::routes::git::git_path(&repo_dir, "info/exclude").await
    })
    .await
    .ok()
    .flatten()
}

/// Best-effort filesystem half of exclude registration. The Git child that
/// produced `exclude_path` has already joined; callers run this mutation under
/// `fs::run_commit_owned` so Stop drains or rejects it atomically.
pub async fn ensure_git_exclude_path(exclude_path: &Path, line: &str) {
    // Resolved through git, not by joining `.git`: every sandbox workdir is a
    // linked worktree, where `.git` is a FILE pointing elsewhere. The old
    // `is_dir()` guard therefore returned early for every real sandbox, so
    // this never ran and `git add -A` at publish staged the tool catalog and
    // its endpoint CREDENTIAL file onto the user's branch.
    let Some(info_dir) = exclude_path.parent().map(std::path::Path::to_path_buf) else {
        return;
    };
    match fs::read_to_string(exclude_path).await {
        Ok(existing) => {
            if !existing.lines().any(|l| l == line) {
                let appended = if existing.ends_with('\n') || existing.is_empty() {
                    format!("{existing}{line}\n")
                } else {
                    format!("{existing}\n{line}\n")
                };
                let _ = fs::write(exclude_path, appended).await;
            }
        }
        Err(_) => {
            // Template-less clones (libgit2/JGit, bare templates) lack
            // info/exclude.
            if fs::create_dir_all(&info_dir).await.is_ok() {
                let _ = fs::write(exclude_path, format!("{line}\n")).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::tempdir;

    async fn ensure_git_exclude(repo_dir: &Path, line: &str) {
        let logs_root = repo_dir
            .parent()
            .unwrap_or(repo_dir)
            .join("git-exclude-test-logs");
        let tasks = Arc::new(TaskRegistry::new(Arc::new(
            crate::log_store::LogStore::new(logs_root),
        )));
        if let Some(path) = resolve_git_exclude(tasks, repo_dir).await {
            ensure_git_exclude_path(&path, line).await;
        }
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git runs");
        assert!(
            status.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    /// A real repository with one commit — the fixture must be real because
    /// the exclude path is now resolved BY git (`rev-parse --git-path`), not
    /// by joining `.git`.
    fn repo_with_one_commit(root: &Path) {
        git(root, &["init", "-q", "-b", "work", "."]);
        git(root, &["config", "user.name", "Test User"]);
        git(root, &["config", "user.email", "test@example.com"]);
        std::fs::write(root.join("f.txt"), "x").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-q", "-m", "initial"]);
    }

    #[tokio::test]
    async fn creates_exclude_file_when_missing() {
        let dir = tempdir().unwrap();
        repo_with_one_commit(dir.path());
        std::fs::remove_file(dir.path().join(".git/info/exclude")).ok();
        ensure_git_exclude(dir.path(), "/.deco/tools/").await;
        let content = fs::read_to_string(dir.path().join(".git/info/exclude"))
            .await
            .unwrap();
        assert!(content.contains("/.deco/tools/"));
    }

    /// The regression this function existed to prevent but did not: every
    /// sandbox workdir is a LINKED WORKTREE, where `.git` is a file. The old
    /// `.git`-is-a-directory guard returned early for all of them, so
    /// `git add -A` at publish staged the tool catalog and its endpoint
    /// credential file onto the user's branch.
    #[tokio::test]
    async fn writes_the_exclude_of_a_linked_worktree() {
        let dir = tempdir().unwrap();
        let main = dir.path().join("main");
        std::fs::create_dir_all(&main).unwrap();
        repo_with_one_commit(&main);
        let worktree = dir.path().join("wt");
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                worktree.to_str().unwrap(),
                "-b",
                "feature",
            ],
        );
        // The premise: `.git` here is a FILE, not a directory.
        assert!(worktree.join(".git").is_file());

        ensure_git_exclude(&worktree, "/.deco/tools/").await;

        // Written wherever git says it lives. `info/exclude` is COMMON to a
        // repository, so for a linked worktree that resolves to the main
        // checkout's git dir — which is exactly right: the exclude has to
        // apply to the worktree that publish runs `git add -A` in, and asking
        // git is what finds it. Joining `<worktree>/.git/info/exclude` (the
        // old code) wrote nowhere, because `.git` is a file here.
        let resolved = crate::routes::git::git_path(&worktree, "info/exclude")
            .await
            .expect("git resolves the worktree exclude path");
        let content = fs::read_to_string(&resolved).await.unwrap();
        assert!(content.contains("/.deco/tools/"), "{content}");

        // The line is in force FROM THE WORKTREE — the property that matters.
        let ignored = Command::new("git")
            .args(["check-ignore", "-q", ".deco/tools/catalog.json"])
            .current_dir(&worktree)
            .status()
            .expect("git runs");
        assert!(ignored.success(), "the exclude must apply in the worktree");
    }

    #[tokio::test]
    async fn is_a_no_op_without_a_git_dir() {
        let dir = tempdir().unwrap();
        ensure_git_exclude(dir.path(), "/.deco/tools/").await;
        assert!(!dir.path().join(".git").exists());
    }

    #[tokio::test]
    async fn does_not_duplicate_an_existing_line() {
        let dir = tempdir().unwrap();
        repo_with_one_commit(dir.path());
        fs::write(
            dir.path().join(".git/info/exclude"),
            "/.deco/tools/\n/other/\n",
        )
        .await
        .unwrap();
        ensure_git_exclude(dir.path(), "/.deco/tools/").await;
        let content = fs::read_to_string(dir.path().join(".git/info/exclude"))
            .await
            .unwrap();
        assert_eq!(content.matches("/.deco/tools/").count(), 1, "{content}");
        assert!(content.contains("/other/"), "{content}");
    }
}
