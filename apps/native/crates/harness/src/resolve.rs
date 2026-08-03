//! Binary resolution — the SHARED CONTRACT between the two Phase 2 agents
//! working this branch: `local-api` resolves harness binaries via env
//! overrides `LOCAL_API_CLAUDE_BIN` / `LOCAL_API_CODEX_BIN` (an absolute
//! path, a bare PATH-relative name, or a JSON array of argv strings —
//! `'["node", "/path/to/stub-harness.mjs"]'`), falling back to a PATH
//! lookup of `claude`/`codex` when unset. This module is that
//! implementation; the differential test suite's stub-harness binary is
//! the other side of the contract, wired in via these exact env vars.
//!
//! The JSON-array-or-plain-string parsing mirrors the convention already
//! used twice elsewhere in this migration —
//! `apps/native/e2e/helpers.ts::resolveLocalApiCmd` and
//! `packages/sandbox/daemon-e2e/daemon.e2e.helpers.ts::resolveDaemonCmd` — so a
//! test author who already knows one of those knows this one.

use std::path::{Path, PathBuf};

/// The two harness CLIs desktop v1 supports (the desktop migration contract decision 1: no
/// `"decopilot"` in the desktop app).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HarnessId {
    ClaudeCode,
    Codex,
}

impl HarnessId {
    /// Stable order pinned by the contract doc's `GET /models` example:
    /// `claude-code` then `codex`.
    pub const ALL: [HarnessId; 2] = [HarnessId::ClaudeCode, HarnessId::Codex];

    /// The wire id used in `harnessId` (dispatch) and `harness` (models).
    pub fn wire_id(self) -> &'static str {
        match self {
            HarnessId::ClaudeCode => "claude-code",
            HarnessId::Codex => "codex",
        }
    }

    pub fn from_wire_id(id: &str) -> Option<Self> {
        match id {
            "claude-code" => Some(HarnessId::ClaudeCode),
            "codex" => Some(HarnessId::Codex),
            _ => None,
        }
    }

    /// SHARED CONTRACT env var name.
    pub fn env_override_var(self) -> &'static str {
        match self {
            HarnessId::ClaudeCode => "LOCAL_API_CLAUDE_BIN",
            HarnessId::Codex => "LOCAL_API_CODEX_BIN",
        }
    }

    /// PATH-lookup fallback name when no override is set.
    pub fn default_binary_name(self) -> &'static str {
        match self {
            HarnessId::ClaudeCode => "claude",
            HarnessId::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// The env override was set (non-empty) but couldn't be parsed as
    /// either a JSON string array or used as a plain string.
    InvalidOverride(String),
    /// A caller supplied a resume token containing no non-whitespace
    /// characters. Passing it to either CLI would look like a resume request
    /// while actually selecting no durable conversation.
    InvalidSessionId,
    /// Resolved argv[0] is neither an executable path nor found on PATH.
    NotFound(String),
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::InvalidOverride(msg) => write!(f, "{msg}"),
            ResolveError::InvalidSessionId => {
                write!(f, "harness session id must not be empty")
            }
            ResolveError::NotFound(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ResolveError {}

/// Resolve the argv PREFIX to spawn for `harness`, reading the SHARED
/// CONTRACT env override from the process environment. Never returns an
/// empty vec.
pub fn resolve_argv(harness: HarnessId) -> Result<Vec<String>, ResolveError> {
    let raw = std::env::var(harness.env_override_var()).ok();
    resolve_argv_from(harness, raw.as_deref())
}

/// Pure variant of [`resolve_argv`] taking the override value explicitly
/// instead of reading the environment — this is the one every unit test in
/// this module calls, so tests never race each other over a shared
/// process-global env var (`std::env::set_var` is famously not
/// parallel-test-safe).
pub fn resolve_argv_from(
    harness: HarnessId,
    override_raw: Option<&str>,
) -> Result<Vec<String>, ResolveError> {
    if let Some(raw) = override_raw {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return parse_override(harness.env_override_var(), trimmed);
        }
    }
    Ok(vec![harness.default_binary_name().to_string()])
}

fn parse_override(var: &str, trimmed: &str) -> Result<Vec<String>, ResolveError> {
    if trimmed.starts_with('[') {
        let parsed: Vec<String> = serde_json::from_str(trimmed).map_err(|e| {
            ResolveError::InvalidOverride(format!("{var} is not a valid JSON string array: {e}"))
        })?;
        if parsed.is_empty() {
            return Err(ResolveError::InvalidOverride(format!(
                "{var} is an empty argv array"
            )));
        }
        return Ok(parsed);
    }
    Ok(vec![trimmed.to_string()])
}

/// Resolve AND verify argv[0] actually exists/is executable — a fast,
/// synchronous, no-subprocess check suitable for the dispatch route's
/// pre-stream "unknown_harness" gate (contract order #7: `lookupHarness`
/// throws → 400 before any process is spawned). A bare name (no path
/// separator) is searched against `PATH` by hand, mirroring POSIX
/// `execvp` search semantics, so a missing CLI surfaces as this crate's
/// own [`ResolveError::NotFound`] instead of an opaque spawn-time I/O
/// error the caller would otherwise have to sniff.
pub fn resolve_checked(harness: HarnessId) -> Result<Vec<String>, ResolveError> {
    let raw = std::env::var(harness.env_override_var()).ok();
    resolve_checked_from(harness, raw.as_deref())
}

/// Pure variant of [`resolve_checked`] — see [`resolve_argv_from`] for why.
pub fn resolve_checked_from(
    harness: HarnessId,
    override_raw: Option<&str>,
) -> Result<Vec<String>, ResolveError> {
    let argv = resolve_argv_from(harness, override_raw)?;
    let program = Path::new(&argv[0]);
    if is_executable_path(program) {
        return Ok(argv);
    }
    if !argv[0].contains(std::path::MAIN_SEPARATOR) && which(&argv[0]).is_some() {
        return Ok(argv);
    }
    Err(ResolveError::NotFound(format!(
        "{} CLI not found: {:?} is neither an executable path nor on PATH",
        harness.wire_id(),
        argv[0],
    )))
}

fn is_executable_path(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|m| m.is_file() && (m.permissions().mode() & 0o111 != 0))
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Manual `PATH` search — POSIX `execvp`-style: for each `PATH` entry,
/// check `<dir>/<name>` is an executable file. Returns the first hit.
/// Module-public (not just crate-private) since `detect.rs` and tests both
/// use it directly.
pub fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if is_executable_path(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_executable(path: &Path) {
        std::fs::File::create(path)
            .unwrap()
            .write_all(b"#!/bin/sh\nexit 0\n")
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    #[test]
    fn no_override_falls_back_to_default_binary_name() {
        assert_eq!(
            resolve_argv_from(HarnessId::ClaudeCode, None).unwrap(),
            vec!["claude".to_string()]
        );
        assert_eq!(
            resolve_argv_from(HarnessId::Codex, None).unwrap(),
            vec!["codex".to_string()]
        );
    }

    #[test]
    fn empty_override_falls_back_to_default_binary_name() {
        assert_eq!(
            resolve_argv_from(HarnessId::ClaudeCode, Some("   ")).unwrap(),
            vec!["claude".to_string()]
        );
    }

    #[test]
    fn absolute_path_override_is_used_verbatim() {
        assert_eq!(
            resolve_argv_from(HarnessId::ClaudeCode, Some("/opt/claude/bin/claude")).unwrap(),
            vec!["/opt/claude/bin/claude".to_string()]
        );
    }

    #[test]
    fn json_array_override_becomes_full_argv() {
        assert_eq!(
            resolve_argv_from(
                HarnessId::Codex,
                Some(r#"["node", "/path/to/stub-harness.mjs", "--codex"]"#)
            )
            .unwrap(),
            vec![
                "node".to_string(),
                "/path/to/stub-harness.mjs".to_string(),
                "--codex".to_string()
            ]
        );
    }

    #[test]
    fn invalid_json_array_override_errors() {
        let err = resolve_argv_from(HarnessId::ClaudeCode, Some("[not json")).unwrap_err();
        assert!(matches!(err, ResolveError::InvalidOverride(_)));
    }

    #[test]
    fn empty_json_array_override_errors() {
        let err = resolve_argv_from(HarnessId::ClaudeCode, Some("[]")).unwrap_err();
        assert!(matches!(err, ResolveError::InvalidOverride(_)));
    }

    #[test]
    fn resolve_checked_accepts_an_existing_executable_override() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("fake-claude");
        make_executable(&bin);
        let argv =
            resolve_checked_from(HarnessId::ClaudeCode, Some(bin.to_str().unwrap())).unwrap();
        assert_eq!(argv, vec![bin.to_str().unwrap().to_string()]);
    }

    #[test]
    fn resolve_checked_rejects_a_nonexistent_override_path() {
        let err = resolve_checked_from(
            HarnessId::ClaudeCode,
            Some("/definitely/not/a/real/path/claude"),
        )
        .unwrap_err();
        assert!(matches!(err, ResolveError::NotFound(_)));
    }

    #[test]
    fn resolve_checked_rejects_a_non_executable_file() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("not-executable");
        std::fs::write(&bin, b"nope").unwrap();
        let err =
            resolve_checked_from(HarnessId::ClaudeCode, Some(bin.to_str().unwrap())).unwrap_err();
        assert!(matches!(err, ResolveError::NotFound(_)));
    }

    #[test]
    fn which_finds_a_binary_placed_on_a_synthetic_path() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("totally-fake-cli-12345");
        make_executable(&bin);
        let joined = std::env::join_paths([dir.path()]).unwrap();
        let found = which_with_path("totally-fake-cli-12345", &joined);
        assert_eq!(found, Some(bin));
    }

    #[test]
    fn which_returns_none_for_a_name_absent_from_path() {
        let dir = tempfile::tempdir().unwrap();
        let joined = std::env::join_paths([dir.path()]).unwrap();
        assert_eq!(
            which_with_path("nonexistent-cli-98765", &joined),
            None::<PathBuf>
        );
    }

    /// Test-only helper: `which()`'s search logic against an explicit
    /// `PATH` value rather than the process environment (see the module
    /// doc's parallel-test-safety rationale).
    fn which_with_path(name: &str, path_var: &std::ffi::OsStr) -> Option<PathBuf> {
        for dir in std::env::split_paths(path_var) {
            let candidate = dir.join(name);
            if is_executable_path(&candidate) {
                return Some(candidate);
            }
        }
        None
    }
}
