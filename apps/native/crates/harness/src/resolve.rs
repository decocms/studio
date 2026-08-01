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

    /// Human-readable product name used in actionable compatibility errors.
    pub fn display_name(self) -> &'static str {
        match self {
            HarnessId::ClaudeCode => "Claude Code",
            HarnessId::Codex => "Codex CLI",
        }
    }

    /// First Studio Native release baseline verified against the complete
    /// interactive contract (PTY, resume, managed MCP, and lifecycle hooks).
    ///
    /// These are deliberately conservative tested baselines, not claims that
    /// every required provider feature was introduced in exactly this patch.
    /// Older versions may implement a subset of the flags, but Studio must not
    /// advertise or launch a combination it has not validated end to end.
    pub const fn minimum_supported_version(self) -> MinimumCliVersion {
        match self {
            HarnessId::ClaudeCode => CLAUDE_CODE_MINIMUM_VERSION,
            HarnessId::Codex => CODEX_MINIMUM_VERSION,
        }
    }

    pub fn upgrade_command(self) -> &'static str {
        match self {
            HarnessId::ClaudeCode => "claude update",
            HarnessId::Codex => "codex update",
        }
    }
}

/// Lowest Claude Code version validated by Studio Native's real-provider
/// implementation spike. This is a tested baseline, not a historical
/// feature-introduction claim.
pub const CLAUDE_CODE_MINIMUM_VERSION: MinimumCliVersion = MinimumCliVersion::new(2, 1, 218);

/// Lowest Codex CLI version validated by Studio Native's real-provider
/// implementation spike. This is a tested baseline, not a historical
/// feature-introduction claim; presence of the required flags in `--help`
/// alone is not a sufficient compatibility signal.
pub const CODEX_MINIMUM_VERSION: MinimumCliVersion = MinimumCliVersion::new(0, 144, 5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MinimumCliVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl MinimumCliVersion {
    pub const fn new(major: u64, minor: u64, patch: u64) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }
}

impl std::fmt::Display for MinimumCliVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliVersion {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Option<String>,
}

impl CliVersion {
    fn parse(token: &str) -> Option<Self> {
        let token = token.trim_matches(|character: char| {
            matches!(
                character,
                '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | ':'
            )
        });
        let token = token
            .strip_prefix('v')
            .or_else(|| token.strip_prefix('V'))
            .unwrap_or(token);
        let without_build = token.split_once('+').map_or(token, |(core, _)| core);
        let (core, prerelease) = match without_build.split_once('-') {
            Some((core, prerelease)) if !prerelease.is_empty() => {
                if !prerelease.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '.' | '-')
                }) {
                    return None;
                }
                (core, Some(prerelease.to_string()))
            }
            Some(_) => return None,
            None => (without_build, None),
        };
        let mut segments = core.split('.');
        let major = segments.next()?.parse().ok()?;
        let minor = segments.next()?.parse().ok()?;
        let patch = segments.next()?.parse().ok()?;
        if segments.next().is_some() {
            return None;
        }
        Some(Self {
            major,
            minor,
            patch,
            prerelease,
        })
    }

    fn satisfies(&self, minimum: MinimumCliVersion) -> bool {
        let installed = (self.major, self.minor, self.patch);
        let required = (minimum.major, minimum.minor, minimum.patch);
        installed > required || (installed == required && self.prerelease.is_none())
    }
}

impl std::fmt::Display for CliVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(prerelease) = &self.prerelease {
            write!(f, "-{prerelease}")?;
        }
        Ok(())
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
    /// `--version` did not complete successfully, so compatibility cannot be
    /// established safely.
    VersionCheckFailed(String),
    /// `--version` succeeded but did not contain a provider version in a
    /// recognized shape.
    UnrecognizedVersion {
        harness: HarnessId,
        output: String,
        minimum: MinimumCliVersion,
    },
    /// The installed CLI is older than Studio Native's tested baseline.
    UnsupportedVersion {
        harness: HarnessId,
        installed: CliVersion,
        minimum: MinimumCliVersion,
    },
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::InvalidOverride(msg) => write!(f, "{msg}"),
            ResolveError::InvalidSessionId => {
                write!(f, "harness session id must not be empty")
            }
            ResolveError::NotFound(msg) => write!(f, "{msg}"),
            ResolveError::VersionCheckFailed(msg) => write!(f, "{msg}"),
            ResolveError::UnrecognizedVersion {
                harness,
                output,
                minimum,
            } => write!(
                f,
                "could not determine the installed {} version from --version output {output:?}; \
                 Studio Native requires {} {minimum} or newer. Upgrade with `{}` and try again",
                harness.display_name(),
                harness.display_name(),
                harness.upgrade_command(),
            ),
            ResolveError::UnsupportedVersion {
                harness,
                installed,
                minimum,
            } => write!(
                f,
                "{} {installed} is unsupported; Studio Native requires {} {minimum} or newer. \
                 Upgrade with `{}` and try again",
                harness.display_name(),
                harness.display_name(),
                harness.upgrade_command(),
            ),
        }
    }
}

impl std::error::Error for ResolveError {}

/// Parse and validate one provider's `--version` output against Studio
/// Native's conservative tested baseline.
///
/// Real output is provider-labelled (`2.1.218 (Claude Code)` and
/// `codex-cli 0.144.5`). Prefer that labelled line so an unrelated runtime
/// warning containing a version cannot win. A single bare-version line is
/// also accepted for wrappers that faithfully proxy the CLI contract.
pub fn require_supported_version(
    harness: HarnessId,
    output: &str,
) -> Result<CliVersion, ResolveError> {
    let minimum = harness.minimum_supported_version();
    let installed =
        parse_cli_version(harness, output).ok_or_else(|| ResolveError::UnrecognizedVersion {
            harness,
            output: summarize_version_output(output),
            minimum,
        })?;
    if installed.satisfies(minimum) {
        return Ok(installed);
    }
    Err(ResolveError::UnsupportedVersion {
        harness,
        installed,
        minimum,
    })
}

fn parse_cli_version(harness: HarnessId, output: &str) -> Option<CliVersion> {
    let mut saw_provider_label = false;
    for line in output.lines() {
        let lowercase = line.to_ascii_lowercase();
        let is_provider_line = match harness {
            HarnessId::ClaudeCode => {
                lowercase.contains("claude code") || lowercase.contains("claude-code")
            }
            HarnessId::Codex => lowercase.contains("codex-cli") || lowercase.contains("codex cli"),
        };
        if !is_provider_line {
            continue;
        }
        saw_provider_label = true;
        let parsed = match harness {
            HarnessId::ClaudeCode => lowercase.find("(claude code)").and_then(|marker| {
                line[..marker]
                    .split_whitespace()
                    .rev()
                    .find_map(CliVersion::parse)
            }),
            HarnessId::Codex => version_after_codex_label(line),
        };
        if parsed.is_some() {
            return parsed;
        }
    }
    if saw_provider_label {
        return None;
    }

    let mut nonempty_lines = output.lines().filter(|line| !line.trim().is_empty());
    let only_line = nonempty_lines.next()?;
    if nonempty_lines.next().is_some() {
        return None;
    }
    let mut tokens = only_line.split_whitespace();
    let only_token = tokens.next()?;
    if tokens.next().is_some() {
        return None;
    }
    CliVersion::parse(only_token)
}

fn version_after_codex_label(line: &str) -> Option<CliVersion> {
    let mut tokens = line.split_whitespace();
    while let Some(token) = tokens.next() {
        if token
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '-')
            .eq_ignore_ascii_case("codex-cli")
        {
            return tokens.next().and_then(CliVersion::parse);
        }
    }
    None
}

fn summarize_version_output(output: &str) -> String {
    const MAX_CHARS: usize = 160;
    let normalized = output.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let summary = chars.by_ref().take(MAX_CHARS).collect::<String>();
    if chars.next().is_some() {
        format!("{summary}…")
    } else {
        summary
    }
}

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

    #[test]
    fn real_provider_version_shapes_meet_the_tested_baselines() {
        assert_eq!(
            require_supported_version(HarnessId::ClaudeCode, "2.1.218 (Claude Code)\n")
                .unwrap()
                .to_string(),
            "2.1.218"
        );
        assert_eq!(
            require_supported_version(HarnessId::Codex, "codex-cli 0.144.5\n")
                .unwrap()
                .to_string(),
            "0.144.5"
        );
    }

    #[test]
    fn provider_label_wins_over_an_unrelated_warning_version() {
        let output = "warning: runtime 99.4.3 is deprecated\ncodex-cli 0.144.6\n";
        assert_eq!(
            require_supported_version(HarnessId::Codex, output)
                .unwrap()
                .to_string(),
            "0.144.6"
        );
    }

    #[test]
    fn provider_named_warning_cannot_masquerade_as_the_cli_version() {
        for (harness, output) in [
            (
                HarnessId::ClaudeCode,
                "warning: Claude Code requires runtime 99.4.3\n",
            ),
            (
                HarnessId::Codex,
                "warning: codex-cli requires runtime 99.4.3\n",
            ),
        ] {
            assert!(matches!(
                require_supported_version(harness, output),
                Err(ResolveError::UnrecognizedVersion { .. })
            ));
        }
    }

    #[test]
    fn a_single_bare_version_is_accepted_for_cli_wrappers() {
        assert!(require_supported_version(HarnessId::ClaudeCode, "v2.2.0\n").is_ok());
        assert!(require_supported_version(HarnessId::Codex, "1.0.0\n").is_ok());
    }

    #[test]
    fn below_baseline_versions_return_actionable_upgrade_errors() {
        let claude = require_supported_version(HarnessId::ClaudeCode, "2.1.217 (Claude Code)\n")
            .unwrap_err();
        assert!(matches!(
            claude,
            ResolveError::UnsupportedVersion {
                harness: HarnessId::ClaudeCode,
                ..
            }
        ));
        let message = claude.to_string();
        assert!(message.contains("Claude Code 2.1.217 is unsupported"));
        assert!(message.contains("requires Claude Code 2.1.218 or newer"));
        assert!(message.contains("`claude update`"));

        let codex = require_supported_version(HarnessId::Codex, "codex-cli 0.144.4\n").unwrap_err();
        let message = codex.to_string();
        assert!(message.contains("Codex CLI 0.144.4 is unsupported"));
        assert!(message.contains("requires Codex CLI 0.144.5 or newer"));
        assert!(message.contains("`codex update`"));
    }

    #[test]
    fn prerelease_of_the_minimum_stable_version_is_not_supported() {
        let error =
            require_supported_version(HarnessId::Codex, "codex-cli 0.144.5-alpha.1\n").unwrap_err();
        assert!(matches!(error, ResolveError::UnsupportedVersion { .. }));
        assert!(error.to_string().contains("0.144.5-alpha.1"));
    }

    #[test]
    fn malformed_or_ambiguous_output_fails_closed_with_the_required_version() {
        for output in [
            "Codex CLI version unknown\n",
            "wrapper 2.1.218\nwarning runtime 99.0.0\n",
        ] {
            let error = require_supported_version(HarnessId::Codex, output).unwrap_err();
            assert!(matches!(
                error,
                ResolveError::UnrecognizedVersion {
                    harness: HarnessId::Codex,
                    ..
                }
            ));
            assert!(error.to_string().contains("requires Codex CLI 0.144.5"));
        }
    }

    #[test]
    fn unrecognized_version_output_is_bounded_before_it_reaches_an_error() {
        let error = require_supported_version(HarnessId::ClaudeCode, &"x".repeat(400))
            .unwrap_err()
            .to_string();
        assert!(error.contains('…'));
        assert!(error.len() < 400);
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
