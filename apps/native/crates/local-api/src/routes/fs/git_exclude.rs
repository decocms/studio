//! Port of `packages/sandbox/daemon/git-exclude.ts::ensureGitExclude`.
//! Registers a line in `<repoDir>/.git/info/exclude` so the git family's
//! shutdown-publish hook (`git add -A`) never commits local-api-managed
//! paths (the tool catalog, its endpoint credential file) onto the user's
//! branch. Best-effort: an unwritable `.git` never blocks the caller.

use std::path::Path;

use tokio::fs;

pub async fn ensure_git_exclude(repo_dir: &Path, line: &str) {
    let git_dir = repo_dir.join(".git");
    let is_git_dir = fs::metadata(&git_dir)
        .await
        .map(|m| m.is_dir())
        .unwrap_or(false);
    if !is_git_dir {
        return;
    }
    let info_dir = git_dir.join("info");
    let exclude_path = info_dir.join("exclude");
    match fs::read_to_string(&exclude_path).await {
        Ok(existing) => {
            if !existing.lines().any(|l| l == line) {
                let appended = if existing.ends_with('\n') || existing.is_empty() {
                    format!("{existing}{line}\n")
                } else {
                    format!("{existing}\n{line}\n")
                };
                let _ = fs::write(&exclude_path, appended).await;
            }
        }
        Err(_) => {
            // Template-less clones (libgit2/JGit, bare templates) lack
            // info/exclude.
            if fs::create_dir_all(&info_dir).await.is_ok() {
                let _ = fs::write(&exclude_path, format!("{line}\n")).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn creates_exclude_file_when_missing() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).await.unwrap();
        ensure_git_exclude(dir.path(), "/.deco/tools/").await;
        let content = fs::read_to_string(dir.path().join(".git/info/exclude"))
            .await
            .unwrap();
        assert!(content.contains("/.deco/tools/"));
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
        fs::create_dir_all(dir.path().join(".git/info"))
            .await
            .unwrap();
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
        assert_eq!(content.matches("/.deco/tools/").count(), 1);
    }
}
