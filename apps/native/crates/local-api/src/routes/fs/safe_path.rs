//! Port of `packages/sandbox/daemon/paths.ts::safePath` — pure, no
//! filesystem access (deliberately: it must NOT resolve symlinks, since
//! `state.app_root`/`state.repo_dir` themselves are often symlinked
//! temp-dir paths on macOS, e.g. `/var/folders/...` -> `/private/var/folders/...`.
//! Canonicalizing here would make a legitimate in-workspace path look like
//! it escapes `app_root` whenever the two disagree on which side of the
//! symlink they're expressed. `path.resolve`/`path.relative` in Node don't
//! touch the filesystem either — this mirrors that lexical-only contract.

use std::path::{Component, Path, PathBuf};

/// Lexically resolves `user_path` against `base_dir` (mirrors
/// `path.resolve(baseDir, userPath)`): an absolute `user_path` wins
/// outright; a relative one is joined onto `base_dir`. The result is then
/// lexically normalized (`.`/`..` collapsed) without touching the
/// filesystem.
fn resolve_against(base_dir: &Path, user_path: &str) -> PathBuf {
    let candidate = if Path::new(user_path).is_absolute() {
        PathBuf::from(user_path)
    } else {
        base_dir.join(user_path)
    };
    normalize_lexical(&candidate)
}

/// Collapses `.`/`..` components without consulting the filesystem (no
/// `canonicalize`). `..` past the root is a no-op, matching
/// `path.resolve('/', '..') === '/'`.
fn normalize_lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                // `pop()` is a no-op when `out` is empty or holds only a
                // root/prefix component — same as Node clamping `..` at
                // the filesystem root instead of erroring past it.
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Returns `Some(resolved)` when `resolved` (the lexical resolution of
/// `user_path` against `base_dir`) stays inside `workspace_root`; `None` on
/// escape. Byte-parity with `paths.ts::safePath`, including allowing
/// `resolved == workspace_root` itself (empty relative path) and siblings
/// reached via `../` that stay inside `workspace_root`.
pub fn safe_path(workspace_root: &Path, base_dir: &Path, user_path: &str) -> Option<PathBuf> {
    let resolved = resolve_against(base_dir, user_path);
    let root = normalize_lexical(workspace_root);
    if is_within(&root, &resolved) {
        Some(resolved)
    } else {
        None
    }
}

/// True when `target` is `root` itself or lexically nested inside it.
fn is_within(root: &Path, target: &Path) -> bool {
    let root_comps: Vec<Component> = root.components().collect();
    let target_comps: Vec<Component> = target.components().collect();
    if target_comps.len() < root_comps.len() {
        return false;
    }
    root_comps
        .iter()
        .zip(target_comps.iter())
        .all(|(a, b)| a == b)
}

/// `resolveReadPath` in `fs.ts`: absolute paths pass through untouched (OS
/// permissions already gate what the process can read); relative paths go
/// through the same clamp as everything else.
pub fn resolve_read_path(
    workspace_root: &Path,
    base_dir: &Path,
    user_path: &str,
) -> Option<PathBuf> {
    if Path::new(user_path).is_absolute() {
        Some(PathBuf::from(user_path))
    } else {
        safe_path(workspace_root, base_dir, user_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn resolves_relative_paths_against_the_repo() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(
            safe_path(&ws, &repo, "src/index.ts"),
            Some(p("/workspace/app/src/index.ts"))
        );
    }

    #[test]
    fn returns_the_repo_for_empty_or_dot_paths() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(safe_path(&ws, &repo, ""), Some(p("/workspace/app")));
        assert_eq!(safe_path(&ws, &repo, "."), Some(p("/workspace/app")));
    }

    #[test]
    fn allows_escaping_the_repo_into_workspace_siblings() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(
            safe_path(&ws, &repo, "../tmp/app/dev"),
            Some(p("/workspace/tmp/app/dev"))
        );
    }

    #[test]
    fn rejects_paths_that_escape_the_workspace() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(safe_path(&ws, &repo, "../../etc/passwd"), None);
        assert_eq!(safe_path(&ws, &repo, "a/../../../etc"), None);
    }

    #[test]
    fn rejects_absolute_paths_outside_the_workspace() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(safe_path(&ws, &repo, "/etc/passwd"), None);
    }

    #[test]
    fn allows_absolute_paths_inside_the_workspace() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(
            safe_path(&ws, &repo, "/workspace/app/src/x.ts"),
            Some(p("/workspace/app/src/x.ts"))
        );
        assert_eq!(
            safe_path(&ws, &repo, "/workspace/tmp/app/dev"),
            Some(p("/workspace/tmp/app/dev"))
        );
    }

    #[test]
    fn resolve_read_path_passes_absolute_through_unclamped() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        // Deliberately outside the workspace — resolveReadPath in the
        // daemon doesn't clamp absolute paths at all.
        assert_eq!(
            resolve_read_path(&ws, &repo, "/etc/passwd"),
            Some(p("/etc/passwd"))
        );
    }

    #[test]
    fn resolve_read_path_clamps_relative_paths() {
        let ws = p("/workspace");
        let repo = p("/workspace/app");
        assert_eq!(resolve_read_path(&ws, &repo, "../../etc/passwd"), None);
    }
}
