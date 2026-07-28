//! The shared canonical repo store that backs per-sandbox git worktrees.
//!
//! Every sandbox used to be its own full `git clone`, so N threads on one
//! repository paid N copies of the object store. Instead there is now ONE bare
//! clone per upstream repository under `<app_root>/repos/…`, and each sandbox's
//! `<app_root>/worktrees/<handle>/repo` is a `git worktree` of it.
//!
//! ## Why the key is the clone URL, not the Studio org
//!
//! [`canonical_repo_dir`] keys on the normalized remote (host + owner + repo),
//! deliberately NOT on the org that reached it: the same repository opened from
//! two orgs must not clone twice — which is the entire point of the store — and
//! an org rename must not orphan it. This is the one place that decision lives;
//! changing the layout means changing this function and nothing else.

use std::path::{Path, PathBuf};

/// `<app_root>/repos/<host>/<owner>/<repo>` for a remote URL, or `None` when
/// the URL isn't one we can key safely.
///
/// Accepts the forms git itself does — `https://host/owner/repo(.git)`,
/// `ssh://git@host/owner/repo`, and the scp-style `git@host:owner/repo` — and
/// normalizes them to the SAME directory, so two sandboxes that name one
/// repository differently still share objects. Case is folded on the host
/// (DNS is case-insensitive) but preserved on the path, which is not
/// universally so.
///
/// Returns `None` rather than guessing for anything that would escape the store
/// or collapse two repositories onto one path: an empty owner or repo, or a
/// segment that is `.`/`..` or contains a separator.
/// `<owner>/<repo>` for a clone URL — the scope a worktree hangs under.
///
/// No host segment. GitHub is the only provider the app accepts, so a `host`
/// level bought nothing and cost a great deal: it put a literal `github.com`
/// in the middle of every worktree path, handle, and log line, and made the
/// handle four segments deep for no information gain.
///
/// The rule is the LAST TWO path segments of whatever git accepts as a remote
/// — `https://github.com/acme/repo.git`, `git@github.com:acme/repo`, and the
/// bare filesystem paths every test fixture uses all reduce to `acme/repo`.
/// Two remotes that agree on owner and repo are treated as the same
/// repository, which under a single provider is simply true.
///
/// Returns `None` rather than guessing for anything that would escape the
/// store: no usable segment at all, or one that is `.`/`..`.
pub fn repo_scope(clone_url: &str) -> Option<Vec<String>> {
    let trimmed = clone_url.trim();
    // Everything after a scheme/host, or the whole thing for a plain path —
    // only the tail matters, so the remote spellings need no special cases.
    let path = match split_remote(trimmed) {
        Some((_, path)) => path,
        None => trimmed.to_string(),
    };
    let stripped = path.strip_suffix(".git").unwrap_or(&path);
    let mut tail: Vec<String> = stripped
        .rsplit('/')
        .filter(|segment| !segment.is_empty())
        .take(2)
        .filter_map(|segment| sanitize(segment).map(str::to_string))
        .collect();
    tail.reverse();
    // One segment is enough for an owner-less remote (`host/repo`, and the
    // bare-path fixtures); GitHub always supplies both.
    (!tail.is_empty()).then_some(tail)
}

pub fn canonical_repo_dir(app_root: &Path, clone_url: &str) -> Option<PathBuf> {
    let (host, path) = split_remote(clone_url.trim())?;
    let mut segments = path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty());

    let owner = segments.next()?;
    // Everything before the final segment is the owner namespace — GitLab-style
    // subgroups (`group/subgroup/repo`) must not collapse onto one directory.
    let rest: Vec<&str> = segments.collect();
    let (repo, middle) = rest.split_last()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);

    let mut dir = app_root.join("repos").join(sanitize(&host.to_lowercase())?);
    dir.push(sanitize(owner)?);
    for segment in middle {
        dir.push(sanitize(segment)?);
    }
    dir.push(sanitize(repo)?);
    Some(dir)
}

/// `(host, path)` for the remote spellings git accepts.
fn split_remote(url: &str) -> Option<(String, String)> {
    if let Some((scheme, rest)) = url.split_once("://") {
        // Strip any `user[:password]@` prefix before the host.
        let rest = rest.rsplit_once('@').map_or(rest, |(_, after)| after);
        let (host, path) = rest.split_once('/')?;
        if host.is_empty() {
            // `file:///abs/path` has no host. Namespace it under a reserved
            // pseudo-host and keep the WHOLE path, so two local repos sharing
            // a directory name can't alias onto one canonical store.
            if scheme.eq_ignore_ascii_case("file") {
                return Some(("local".to_string(), path.to_string()));
            }
            return None;
        }
        return Some((host.to_string(), path.to_string()));
    }
    // scp-style: `git@host:owner/repo`. The colon separates host from path, so
    // a `:` that is really a port (`host:22/owner/repo`) is not this form.
    let (before, path) = url.split_once(':')?;
    if path.starts_with('/') || path.chars().next()?.is_ascii_digit() {
        return None;
    }
    let host = before.rsplit_once('@').map_or(before, |(_, after)| after);
    Some((host.to_string(), path.to_string()))
}

/// Drop a canonical repo's registrations for worktrees whose directories are
/// gone.
///
/// Removing a sandbox's workdir with `remove_dir_all` leaves the canonical repo
/// still listing it in `git worktree list`, and git then refuses to re-add a
/// worktree at that same path ("already registered"). Pruning after any such
/// removal is what keeps re-provisioning a handle working.
///
/// Best-effort by design: a canonical repo that doesn't exist yet, or a `git`
/// that fails, is not a reason to fail the caller's operation — the worst case
/// is a stale entry that the next prune clears.
pub async fn prune_worktrees(app_root: &Path, clone_url: &str) {
    let Some(canonical) = canonical_repo_dir(app_root, clone_url) else {
        return;
    };
    prune_repo(&canonical).await;
}

/// Prune every canonical repo in the store.
///
/// Runs once at boot because a sandbox directory can vanish between runs — a
/// user clearing Application Support, an interrupted move — leaving git still
/// listing it and refusing to re-add a worktree at that path, which strands
/// the handle until something prunes.
///
/// This cannot lose work: `git worktree prune` only drops registrations whose
/// directory is already gone, and never touches a worktree still on disk.
pub async fn prune_all(app_root: &Path) {
    let root = app_root.join("repos");
    // Repos nest at `repos/<host>/<owner>[/<subgroup>…]/<repo>`, so the depth
    // is not fixed; descend until a directory looks like the bare repo itself.
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            continue;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if !entry.file_type().await.is_ok_and(|kind| kind.is_dir()) {
                continue;
            }
            if is_bare_repo(&path).await {
                prune_repo(&path).await;
            } else {
                pending.push(path);
            }
        }
    }
}

/// `git worktree prune` one canonical repo, best-effort.
///
/// A repo that doesn't exist yet, or a `git` that fails, is never a reason to
/// fail the caller's operation — the worst case is a stale entry the next
/// prune clears.
async fn prune_repo(canonical: &Path) {
    if !is_bare_repo(canonical).await {
        return;
    }
    let canonical_str = canonical.to_string_lossy().into_owned();
    let result = tokio::process::Command::new("git")
        .args(["-C", &canonical_str, "worktree", "prune"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    if let Err(error) = result {
        tracing::warn!(%error, repo = %canonical_str, "git worktree prune failed");
    }
}

/// Whether a directory is one of the store's bare clones.
///
/// A bare repo keeps `HEAD` at its root, where a namespace directory
/// (`repos/github.com`) has only subdirectories — that is the whole
/// distinction the walk needs.
async fn is_bare_repo(dir: &Path) -> bool {
    tokio::fs::metadata(dir.join("HEAD"))
        .await
        .is_ok_and(|meta| meta.is_file())
}

/// A path segment that cannot escape the store or name a parent.
fn sanitize(segment: &str) -> Option<&str> {
    if segment.is_empty()
        || segment == "."
        || segment == ".."
        || segment.contains('/')
        || segment.contains('\\')
    {
        return None;
    }
    Some(segment)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(url: &str) -> Option<String> {
        canonical_repo_dir(Path::new("/app"), url).map(|p| p.to_string_lossy().into_owned())
    }

    #[test]
    fn every_spelling_of_one_repo_maps_to_the_same_directory() {
        // The whole point of the store: name it differently, share objects.
        let expected = Some("/app/repos/github.com/acme/site".to_string());
        for url in [
            "https://github.com/acme/site.git",
            "https://github.com/acme/site",
            "https://GitHub.com/acme/site.git",
            "https://user:token@github.com/acme/site.git",
            "ssh://git@github.com/acme/site.git",
            "git@github.com:acme/site.git",
            "  https://github.com/acme/site.git  ",
        ] {
            assert_eq!(dir(url), expected, "{url}");
        }
    }

    #[test]
    fn distinct_repos_never_collapse_onto_one_directory() {
        assert_ne!(
            dir("https://github.com/acme/site"),
            dir("https://github.com/other/site")
        );
        assert_ne!(
            dir("https://github.com/acme/site"),
            dir("https://gitlab.com/acme/site")
        );
        // Case is preserved on the path: these are two repos on most forges.
        assert_ne!(
            dir("https://github.com/acme/Site"),
            dir("https://github.com/acme/site")
        );
    }

    #[test]
    fn subgroups_keep_their_namespace() {
        // Collapsing `group/sub/repo` to `group/repo` would alias two repos.
        assert_eq!(
            dir("https://gitlab.com/group/sub/repo.git"),
            Some("/app/repos/gitlab.com/group/sub/repo".to_string())
        );
    }

    #[test]
    fn local_file_remotes_keep_their_whole_path() {
        // `file://` has no host, but local clones must still share a canonical
        // store — and two repos whose directories are both named `site` must
        // not collapse onto one.
        assert_eq!(
            dir("file:///Users/dev/work/site"),
            Some("/app/repos/local/Users/dev/work/site".to_string())
        );
        assert_ne!(
            dir("file:///Users/dev/a/site"),
            dir("file:///Users/dev/b/site")
        );
    }

    #[test]
    fn refuses_urls_that_would_escape_or_alias_the_store() {
        for url in [
            "",
            "not a url",
            "https://github.com/acme",      // no repo segment
            "https://github.com//site.git", // empty owner
            "https://github.com/../../etc/passwd",
            "git@github.com:../evil.git",
            "https://github.com/acme/.git", // repo name empties out
        ] {
            assert_eq!(dir(url), None, "{url}");
        }
    }

    /// The regression `prune_worktrees` exists for: git keeps listing a
    /// worktree whose directory was deleted, and refuses to re-add one at that
    /// path — which would strand a sandbox whose workdir was cleared as
    /// invalid.
    #[tokio::test]
    async fn prune_lets_a_removed_worktree_path_be_reused() {
        use std::process::Command;

        let root = tempfile::tempdir().expect("tempdir");
        let app_root = root.path();
        let origin = app_root.join("origin");
        let clone_url = format!("file://{}", origin.display());

        // A real repository with one commit to branch from.
        std::fs::create_dir_all(&origin).unwrap();
        let git = |args: &[&str], cwd: &Path| {
            let ok = Command::new("git")
                .args(args)
                .current_dir(cwd)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e")
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(&["init", "-q", "-b", "main"], &origin);
        std::fs::write(origin.join("f.txt"), "hi").unwrap();
        git(&["add", "."], &origin);
        git(&["commit", "-qm", "init"], &origin);

        let canonical = canonical_repo_dir(app_root, &clone_url).expect("keyable url");
        std::fs::create_dir_all(canonical.parent().unwrap()).unwrap();
        git(
            &[
                "clone",
                "--bare",
                "-q",
                &clone_url,
                canonical.to_str().unwrap(),
            ],
            app_root,
        );

        let wt = app_root.join("worktrees/h1/repo");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        let add = |dest: &Path| {
            Command::new("git")
                .args([
                    "-C",
                    canonical.to_str().unwrap(),
                    "worktree",
                    "add",
                    "--force",
                    "-B",
                    "thread",
                    dest.to_str().unwrap(),
                    "HEAD",
                ])
                .output()
                .expect("git runs")
                .status
                .success()
        };
        assert!(add(&wt), "first worktree add succeeds");

        // Simulate the invalid-workdir clear.
        std::fs::remove_dir_all(&wt).unwrap();
        assert!(
            !add(&wt),
            "git must refuse the still-registered path — otherwise this fn is pointless"
        );

        prune_worktrees(app_root, &clone_url).await;
        assert!(add(&wt), "after prune the path is reusable again");
    }

    /// The boot walk has to reach repos at any nesting depth (subgroups) and
    /// must not mistake a namespace directory for a repo.
    #[tokio::test]
    async fn prune_all_reaches_repos_at_every_depth() {
        use std::process::Command;

        let root = tempfile::tempdir().expect("tempdir");
        let app_root = root.path();

        // Two repos at different depths, plus a namespace dir holding neither.
        let deep = app_root.join("repos/gitlab.com/group/sub/repo");
        let shallow = app_root.join("repos/github.com/acme/site");
        std::fs::create_dir_all(app_root.join("repos/empty.com/owner")).unwrap();
        // A bare repo has no worktree to commit in, so build a normal origin
        // first and bare-clone it into each canonical path.
        let origin = root.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        let git = |args: Vec<&str>, cwd: &Path| {
            let ok = Command::new("git")
                .args(&args)
                .current_dir(cwd)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@e")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@e")
                .output()
                .expect("git runs")
                .status
                .success();
            assert!(ok, "git {args:?} failed");
        };
        git(vec!["init", "-q", "-b", "main"], &origin);
        std::fs::write(origin.join("f.txt"), "hi").unwrap();
        git(vec!["add", "."], &origin);
        git(vec!["commit", "-qm", "init"], &origin);

        let mut removed = Vec::new();
        for canonical in [&deep, &shallow] {
            std::fs::create_dir_all(canonical.parent().unwrap()).unwrap();
            let path = canonical.to_str().unwrap();
            git(
                vec!["clone", "--bare", "-q", origin.to_str().unwrap(), path],
                app_root,
            );
            let wt = app_root.join(crate::sandbox::WORKTREES_DIR).join(format!(
                "h-{}",
                canonical.file_name().unwrap().to_string_lossy()
            ));
            std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
            assert!(
                Command::new("git")
                    .args([
                        "-C",
                        path,
                        "worktree",
                        "add",
                        "--force",
                        "-B",
                        "thread",
                        wt.to_str().unwrap(),
                        "HEAD",
                    ])
                    .output()
                    .expect("git runs")
                    .status
                    .success(),
                "worktree add in {path}"
            );
            std::fs::remove_dir_all(&wt).unwrap();
            removed.push(wt);
        }

        prune_all(app_root).await;

        // Both registrations are gone, at both depths, so each path is
        // reusable — the reason the walk exists.
        for (canonical, wt) in [&deep, &shallow].into_iter().zip(&removed) {
            let list = Command::new("git")
                .args(["-C", canonical.to_str().unwrap(), "worktree", "list"])
                .output()
                .expect("git runs");
            let listed = String::from_utf8_lossy(&list.stdout).into_owned();
            assert!(
                !listed.contains(wt.to_str().unwrap()),
                "stale worktree still registered in {canonical:?}: {listed}"
            );
        }
    }

    #[test]
    fn a_port_is_not_read_as_an_scp_path() {
        // `host:22/owner/repo` is a URL with a port, not scp-style — treating
        // the port as the owner would key every such repo under "22".
        assert_eq!(dir("github.com:22/acme/site.git"), None);
        assert_eq!(
            dir("ssh://git@github.com:22/acme/site.git"),
            Some("/app/repos/github.com:22/acme/site".to_string()),
        );
    }
}
