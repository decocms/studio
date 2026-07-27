//! Port of the pure helper functions from
//! `packages/sandbox/daemon/routes/fs.ts`'s glob section (everything from
//! `GLOB_EXCLUDE_DIRS` down through `collectEmptyDirectories`), plus a
//! from-scratch directory walk that reproduces `Bun.Glob(...).scan({
//! onlyFiles:false, followSymlinks:false, dot:true })`'s observable output
//! (there's no Bun.Glob equivalent in the `globset`/`walkdir` combo this
//! crate has, so the walk itself is new code — the *shape* of every
//! function below, including names, mirrors `fs.ts` 1:1 so the two stay
//! easy to diff against each other).

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use globset::GlobBuilder;

/// Skipped during a glob walk — node_modules/.git noise drowns out useful
/// matches and isn't what an agent ever wants to glob/grep through.
pub fn glob_exclude_dirs() -> &'static HashSet<&'static str> {
    static DIRS: std::sync::OnceLock<HashSet<&'static str>> = std::sync::OnceLock::new();
    DIRS.get_or_init(|| {
        [
            "node_modules",
            ".git",
            ".next",
            "dist",
            "build",
            ".turbo",
            ".cache",
            ".ssh",
            ".aws",
            ".gnupg",
        ]
        .into_iter()
        .collect()
    })
}

/// Default cap for agent glob calls.
pub const GLOB_RESULT_LIMIT: usize = 1000;
/// Hard ceiling when callers pass an explicit `limit` (file explorer).
pub const GLOB_MAX_RESULT_LIMIT: usize = 10_000;

pub fn path_segment_depth(rel_path: &str) -> usize {
    rel_path.split('/').filter(|s| !s.is_empty()).count()
}

/// Register repo-relative ancestor directories up to `max_depth`.
pub fn register_glob_ancestor_directories(
    repo_relative_path: &str,
    max_depth: usize,
    directory_paths: &mut HashSet<String>,
    is_file: bool,
) {
    let parts: Vec<&str> = repo_relative_path
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let dir_parts: &[&str] = if is_file && !parts.is_empty() {
        &parts[..parts.len() - 1]
    } else {
        &parts[..]
    };
    let take = dir_parts.len().min(max_depth);
    for i in 1..=take {
        directory_paths.insert(dir_parts[..i].join("/"));
    }
}

pub fn resolve_glob_result_limit(limit: Option<f64>) -> usize {
    match limit {
        None => GLOB_RESULT_LIMIT,
        Some(n) if !n.is_finite() || n < 1.0 => GLOB_RESULT_LIMIT,
        Some(n) => (n.floor() as usize).min(GLOB_MAX_RESULT_LIMIT),
    }
}

/// Seed value for [`walk_repo_within_max_depth`]'s `repo_rel_dir` — the
/// repo-relative path of `search_path` itself. Mirrors
/// `repoRelativePrefix` in `fs.ts` for the common case (`search_path`
/// nested under `repo_dir`, which is all `safe_path` ever produces); falls
/// back to an empty prefix for the rare sibling-of-repo case (not
/// exercised by any test — `walkRepoWithinMaxDepth` is only reachable via
/// the `pattern === "**/*"` fast path, and a caller-supplied `path` that
/// escapes `repo_dir` but stays inside the workspace is an edge case the
/// TS implementation itself doesn't special-case either).
pub fn repo_relative_prefix(search_path: &Path, repo_dir: &Path) -> String {
    if search_path == repo_dir {
        return String::new();
    }
    let repo_str = repo_dir.to_string_lossy().replace('\\', "/");
    let search_str = search_path.to_string_lossy().replace('\\', "/");
    let prefix = format!("{repo_str}/");
    search_str
        .strip_prefix(prefix.as_str())
        .map(str::to_string)
        .unwrap_or_default()
}

fn join_repo_relative(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Paths whose any segment is in [`glob_exclude_dirs`] are skipped.
pub fn is_glob_path_allowed(rel: &str) -> bool {
    !rel.split('/').any(|seg| glob_exclude_dirs().contains(seg))
}

pub struct GlobScanState {
    pub file_paths: Vec<String>,
    pub directory_paths: HashSet<String>,
    pub result_limit: usize,
}

/// Depth-bounded directory walk — avoids scanning the full tree for
/// `max_depth`. Mirrors `walkRepoWithinMaxDepth` in `fs.ts`. Returns
/// `true` when the walk hit `state.result_limit` (truncated).
pub fn walk_repo_within_max_depth(
    abs_dir: &Path,
    repo_rel_dir: &str,
    max_depth: usize,
    state: &mut GlobScanState,
) -> bool {
    let entries = match fs::read_dir(abs_dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    // Stable iteration order keeps output deterministic (and tests sane) —
    // `read_dir` order is filesystem-dependent otherwise.
    let mut sorted: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    sorted.sort_by_key(|e| e.file_name());

    for entry in sorted {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        let child_rel = join_repo_relative(repo_rel_dir, &name);
        if !is_glob_path_allowed(&child_rel) {
            continue;
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }

        let depth = path_segment_depth(&child_rel);

        if file_type.is_dir() {
            if depth > max_depth {
                register_glob_ancestor_directories(
                    &child_rel,
                    max_depth,
                    &mut state.directory_paths,
                    false,
                );
                continue;
            }
            state.directory_paths.insert(child_rel.clone());
            if depth < max_depth {
                let child_abs = abs_dir.join(&*name);
                if walk_repo_within_max_depth(&child_abs, &child_rel, max_depth, state) {
                    return true;
                }
            }
        } else if file_type.is_file() {
            if depth > max_depth {
                register_glob_ancestor_directories(
                    &child_rel,
                    max_depth,
                    &mut state.directory_paths,
                    true,
                );
                continue;
            }
            state.file_paths.push(child_rel);
            if state.file_paths.len() >= state.result_limit {
                return true;
            }
        }
    }
    false
}

/// Repo-relative paths are a wire contract (agents/tools glob+grep over
/// them) that must always come back POSIX-style (forward slashes). Mirrors
/// `toRepoRelativePath` in `fs.ts`.
pub fn to_repo_relative_path(abs: &str, search_path: &str, repo_dir: &str) -> String {
    let normalized_abs = abs.replace('\\', "/");
    let normalized_repo_dir = repo_dir.replace('\\', "/");
    let normalized_search_path = search_path.replace('\\', "/");
    let repo_prefix = format!("{normalized_repo_dir}/");
    if let Some(stripped) = normalized_abs.strip_prefix(&repo_prefix) {
        return stripped.to_string();
    }
    let search_prefix = format!("{normalized_search_path}/");
    if let Some(stripped) = normalized_abs.strip_prefix(&search_prefix) {
        return stripped.to_string();
    }
    normalized_abs
}

/// Empty directories have no nested files and no nested directories in the
/// scan. Mirrors `collectEmptyDirectories` in `fs.ts`.
pub fn collect_empty_directories(file_paths: &[String], directory_paths: &[String]) -> Vec<String> {
    let dir_set: HashSet<&str> = directory_paths.iter().map(|s| s.as_str()).collect();
    let mut empty = Vec::new();
    for dir in directory_paths {
        if dir.is_empty() {
            continue;
        }
        let prefix = format!("{dir}/");
        let has_nested_file = file_paths.iter().any(|f| f.starts_with(&prefix));
        let has_nested_dir = dir_set
            .iter()
            .any(|other| *other != dir.as_str() && other.starts_with(&prefix));
        if !has_nested_file && !has_nested_dir {
            empty.push(dir.clone());
        }
    }
    empty
}

/// Result of a general (non-`**/*`-fast-path) glob scan.
pub struct GlobMatch {
    pub file_paths: Vec<String>,
    pub directory_paths: HashSet<String>,
    pub truncated: bool,
}

/// Reproduces the `Bun.Glob(pattern).scan({ cwd: searchPath, onlyFiles:
/// false, followSymlinks: false, dot: true })` branch of `makeGlobHandler`:
/// walk `search_path` (pruning [`glob_exclude_dirs`] early — output-
/// equivalent to filtering post-hoc via [`is_glob_path_allowed`], since
/// nothing under an excluded dir could ever survive that filter), matching
/// each entry's repo-relative path against `pattern`.
pub fn scan_glob(
    search_path: &Path,
    repo_dir: &Path,
    pattern: &str,
    max_depth: Option<usize>,
    result_limit: usize,
) -> Result<GlobMatch, globset::Error> {
    // `literal_separator(true)`: a single `*`/`?` must not cross a `/`
    // (globset's default is permissive here — the opposite of the
    // Bun.Glob/picomatch semantics `fs.ts` relies on, where `*.txt` only
    // matches top-level files and `**` is required to cross directories).
    let matcher = GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()?
        .compile_matcher();
    let mut file_paths = Vec::new();
    let mut directory_paths: HashSet<String> = HashSet::new();
    let mut truncated = false;

    let mut stack: Vec<(std::path::PathBuf, String)> =
        vec![(search_path.to_path_buf(), String::new())];
    // Deterministic order.
    while let Some((abs_dir, rel_dir)) = stack.pop() {
        let entries = match fs::read_dir(&abs_dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let mut sorted: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        sorted.sort_by_key(|e| e.file_name());
        // Push in reverse so pop() visits in ascending order.
        for entry in sorted.into_iter().rev() {
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy().to_string();
            let scan_rel = join_repo_relative(&rel_dir, &name);
            if !is_glob_path_allowed(&scan_rel) {
                continue;
            }
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }
            let abs = abs_dir.join(&name);
            let matched = matcher.is_match(&scan_rel);

            if matched {
                let rel_path = to_repo_relative_path(
                    &abs.to_string_lossy(),
                    &search_path.to_string_lossy(),
                    &repo_dir.to_string_lossy(),
                );
                let depth = path_segment_depth(&rel_path);
                if let Some(max) = max_depth {
                    if depth > max {
                        register_glob_ancestor_directories(
                            &rel_path,
                            max,
                            &mut directory_paths,
                            file_type.is_file(),
                        );
                        continue;
                    }
                }
                if file_type.is_dir() {
                    directory_paths.insert(rel_path);
                } else if file_type.is_file() {
                    file_paths.push(rel_path);
                    if file_paths.len() >= result_limit {
                        truncated = true;
                        return Ok(GlobMatch {
                            file_paths,
                            directory_paths,
                            truncated,
                        });
                    }
                }
            }

            if file_type.is_dir() {
                stack.push((abs, scan_rel));
            }
        }
    }

    Ok(GlobMatch {
        file_paths,
        directory_paths,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir_all, write};
    use tempfile::tempdir;

    #[test]
    fn path_segment_depth_counts_segments() {
        assert_eq!(path_segment_depth("a/b/c.ts"), 3);
        assert_eq!(path_segment_depth("README.md"), 1);
    }

    #[test]
    fn register_glob_ancestor_directories_adds_ancestors_up_to_max_depth() {
        let mut dirs = HashSet::new();
        register_glob_ancestor_directories("a/b/c/d.ts", 3, &mut dirs, true);
        let mut v: Vec<_> = dirs.into_iter().collect();
        v.sort();
        assert_eq!(v, vec!["a", "a/b", "a/b/c"]);
    }

    #[test]
    fn register_glob_ancestor_directories_handles_directory_paths() {
        let mut dirs = HashSet::new();
        register_glob_ancestor_directories("a/b/c/d", 3, &mut dirs, false);
        let mut v: Vec<_> = dirs.into_iter().collect();
        v.sort();
        assert_eq!(v, vec!["a", "a/b", "a/b/c"]);
    }

    #[test]
    fn to_repo_relative_path_strips_repo_dir_prefix_posix() {
        assert_eq!(
            to_repo_relative_path("/repo/needle.txt", "/repo", "/repo"),
            "needle.txt"
        );
    }

    #[test]
    fn to_repo_relative_path_strips_windows_style_prefix() {
        assert_eq!(
            to_repo_relative_path(
                "C:\\Users\\runner\\repo\\needle.txt",
                "C:\\Users\\runner\\repo",
                "C:\\Users\\runner\\repo",
            ),
            "needle.txt"
        );
    }

    #[test]
    fn to_repo_relative_path_falls_back_to_search_path_prefix() {
        assert_eq!(
            to_repo_relative_path(
                "C:\\Users\\runner\\app\\dev\\index.ts",
                "C:\\Users\\runner\\app\\dev",
                "C:\\Users\\runner\\app\\repo",
            ),
            "index.ts"
        );
    }

    #[test]
    fn to_repo_relative_path_normalizes_nested_windows_subdirectories() {
        assert_eq!(
            to_repo_relative_path(
                "C:\\Users\\runner\\repo\\.deco\\tools\\ARCHIVE_EMAIL.json",
                "C:\\Users\\runner\\repo",
                "C:\\Users\\runner\\repo",
            ),
            ".deco/tools/ARCHIVE_EMAIL.json"
        );
    }

    #[test]
    fn collect_empty_directories_ignores_parents_of_nested_directories() {
        let dirs = vec!["src".to_string(), "src/components".to_string()];
        assert_eq!(
            collect_empty_directories(&[], &dirs),
            vec!["src/components".to_string()]
        );
    }

    #[test]
    fn resolve_glob_result_limit_caps_at_max() {
        assert_eq!(resolve_glob_result_limit(None), GLOB_RESULT_LIMIT);
        assert_eq!(
            resolve_glob_result_limit(Some((GLOB_MAX_RESULT_LIMIT + 999) as f64)),
            GLOB_MAX_RESULT_LIMIT
        );
    }

    #[test]
    fn scan_glob_finds_top_level_txt_files() {
        let dir = tempdir().unwrap();
        write(dir.path().join("x.txt"), "").unwrap();
        write(dir.path().join("y.rs"), "").unwrap();
        let result = scan_glob(dir.path(), dir.path(), "*.txt", None, GLOB_RESULT_LIMIT).unwrap();
        assert!(result.file_paths.contains(&"x.txt".to_string()));
        assert!(!result.file_paths.contains(&"y.rs".to_string()));
        assert!(result.directory_paths.is_empty());
    }

    #[test]
    fn scan_glob_includes_dot_directories_such_as_deco() {
        let dir = tempdir().unwrap();
        create_dir_all(dir.path().join(".deco/blocks")).unwrap();
        write(dir.path().join(".deco/blocks/foo.json"), "{}").unwrap();
        let result = scan_glob(dir.path(), dir.path(), "**/*", None, GLOB_RESULT_LIMIT).unwrap();
        assert!(result
            .file_paths
            .contains(&".deco/blocks/foo.json".to_string()));
    }

    #[test]
    fn scan_glob_shows_dotfiles_but_excludes_glob_exclude_dirs() {
        let dir = tempdir().unwrap();
        write(dir.path().join(".env"), "SECRET=1").unwrap();
        create_dir_all(dir.path().join(".deco/blocks")).unwrap();
        write(dir.path().join(".deco/blocks/foo.json"), "{}").unwrap();
        create_dir_all(dir.path().join(".git")).unwrap();
        write(dir.path().join(".git/config"), "").unwrap();
        let result = scan_glob(dir.path(), dir.path(), "**/*", None, GLOB_RESULT_LIMIT).unwrap();
        assert!(result.file_paths.contains(&".env".to_string()));
        assert!(result
            .file_paths
            .contains(&".deco/blocks/foo.json".to_string()));
        assert!(!result.file_paths.contains(&".git/config".to_string()));
    }

    #[test]
    fn scan_glob_includes_empty_directories() {
        let dir = tempdir().unwrap();
        create_dir_all(dir.path().join("tavano-folder")).unwrap();
        let result = scan_glob(dir.path(), dir.path(), "**/*", None, GLOB_RESULT_LIMIT).unwrap();
        assert!(result.directory_paths.contains("tavano-folder"));
    }

    #[test]
    fn scan_glob_includes_gitkeep_folder_markers_as_files() {
        let dir = tempdir().unwrap();
        create_dir_all(dir.path().join("empty-dir")).unwrap();
        write(dir.path().join("empty-dir/.gitkeep"), "").unwrap();
        let result = scan_glob(dir.path(), dir.path(), "**/*", None, GLOB_RESULT_LIMIT).unwrap();
        assert!(result
            .file_paths
            .contains(&"empty-dir/.gitkeep".to_string()));
    }

    #[test]
    fn scan_glob_explicit_limit_truncates_results() {
        let dir = tempdir().unwrap();
        for i in 0..7 {
            write(dir.path().join(format!("file-{i}.txt")), "").unwrap();
        }
        let result = scan_glob(dir.path(), dir.path(), "*.txt", None, 5).unwrap();
        assert_eq!(result.file_paths.len(), 5);
        assert!(result.truncated);
    }

    #[test]
    fn walk_repo_within_max_depth_skips_deeper_files_but_registers_ancestors() {
        let dir = tempdir().unwrap();
        create_dir_all(dir.path().join("a/b/c/d")).unwrap();
        write(dir.path().join("a/b/c/d/deep.txt"), "x").unwrap();
        write(dir.path().join("a/b/shallow.txt"), "y").unwrap();
        let mut state = GlobScanState {
            file_paths: Vec::new(),
            directory_paths: HashSet::new(),
            result_limit: GLOB_RESULT_LIMIT,
        };
        walk_repo_within_max_depth(dir.path(), "", 3, &mut state);
        assert!(state.file_paths.contains(&"a/b/shallow.txt".to_string()));
        assert!(!state.file_paths.contains(&"a/b/c/d/deep.txt".to_string()));
        assert!(state.directory_paths.contains("a/b/c"));
    }

    #[test]
    fn repo_relative_prefix_matches_search_path_equal_to_repo_dir() {
        let dir = tempdir().unwrap();
        assert_eq!(repo_relative_prefix(dir.path(), dir.path()), "");
    }
}
