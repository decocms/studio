//! PATH repair for GUI launches.
//!
//! A GUI launch inherits a minimal PATH: launchd gives a Finder/Dock-launched
//! macOS app `/usr/bin:/bin:/usr/sbin:/sbin`, and a Linux `.desktop` or
//! systemd-user launch gets whatever the session manager exported, which is
//! likewise none of the user's shell config. So user-installed binaries —
//! `claude`, `codex`, `bun`, `rg`, Homebrew's `git` — are invisible to every
//! child this process spawns. All spawn sites (harness probes, setup installs, the
//! script runner) rely on the inherited environment, so repairing PATH once
//! here, before `local-api` boots, fixes them all.
//!
//! Two layers, both additive (entries are only ever appended, never removed):
//! 1. Ask the user's login shell for its PATH (sources `~/.zprofile` /
//!    `~/.bash_profile`, where Homebrew and bun put their exports). Bounded
//!    by a timeout so a hung profile cannot stall boot.
//! 2. Append well-known install directories that exist on disk — covers
//!    users whose exports live only in interactive-shell config (`~/.zshrc`),
//!    which a non-interactive login shell never sources.

/// Repairs the process PATH in place. Call once at startup, before anything
/// spawns children. No-op on Windows, where GUI apps inherit the user PATH.
pub fn repair() {
    #[cfg(unix)]
    unix::repair();
}

#[cfg(unix)]
mod unix {
    use std::path::PathBuf;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// Upper bound on the login-shell probe. Typical profiles answer in well
    /// under 200ms; a profile that blocks (waiting on a tty, a network call)
    /// must not hold the app's first window hostage.
    const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

    const DELIM_START: &str = "__DECO_PATH>";
    const DELIM_END: &str = "<DECO_PATH__";

    /// Login shell to probe when `$SHELL` is unset or empty: macOS has shipped
    /// zsh as the default login shell since Catalina; other unices default to
    /// bash.
    #[cfg(target_os = "macos")]
    const DEFAULT_SHELL: &str = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    const DEFAULT_SHELL: &str = "/bin/bash";

    /// System-wide install locations, most specific first. macOS means
    /// Homebrew (Apple Silicon prefix first, Intel/manual second); on Linux
    /// `/snap/bin` and the Linuxbrew prefix are the equivalent opt-in
    /// locations a minimal session PATH omits.
    #[cfg(target_os = "macos")]
    const SYSTEM_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];
    #[cfg(not(target_os = "macos"))]
    const SYSTEM_DIRS: &[&str] = &[
        "/usr/local/bin",
        "/snap/bin",
        "/home/linuxbrew/.linuxbrew/bin",
    ];

    pub(super) fn repair() {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let probed = probe_login_shell_path(PROBE_TIMEOUT);
        let fallbacks: Vec<PathBuf> = fallback_dirs()
            .into_iter()
            .filter(|dir| dir.is_dir())
            .collect();
        let repaired = compose_path(probed.as_deref(), &inherited, &fallbacks);
        if repaired != inherited {
            // Safe in edition 2021; runs before local-api's runtime exists,
            // and the only thread spawned so far (the probe's pipe reader)
            // has been joined.
            std::env::set_var("PATH", &repaired);
            tracing::info!(
                probe_ok = probed.is_some(),
                path = %repaired,
                "repaired PATH for GUI launch"
            );
        }
    }

    /// Runs `$SHELL -l -c 'printf …$PATH…'` and extracts the delimited value.
    /// Login (`-l`) but NOT interactive: `-i` can block on prompt frameworks
    /// or tty access, and login config is where PATH exports belong anyway.
    /// Delimiters keep profile chatter on stdout from corrupting the value.
    fn probe_login_shell_path(timeout: Duration) -> Option<String> {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_SHELL.to_string());
        let script = format!("printf '%s' \"{DELIM_START}$PATH{DELIM_END}\"");
        let mut child = std::process::Command::new(&shell)
            .args(["-l", "-c", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        // Drain stdout on a thread so a chatty profile can never fill the
        // pipe buffer and deadlock against our exit-polling below.
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            use std::io::Read;
            let mut buffer = String::new();
            let _ = stdout.read_to_string(&mut buffer);
            buffer
        });

        let deadline = Instant::now() + timeout;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    tracing::warn!(%shell, "login-shell PATH probe timed out");
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => {
                    let _ = reader.join();
                    return None;
                }
            }
        };
        let output = reader.join().ok()?;
        if !status.success() {
            tracing::warn!(%shell, %status, "login-shell PATH probe failed");
            return None;
        }
        extract_delimited(&output).map(str::to_string)
    }

    /// Pulls the PATH value out from between the probe delimiters, rejecting
    /// anything that doesn't contain at least one absolute directory.
    fn extract_delimited(output: &str) -> Option<&str> {
        let start = output.find(DELIM_START)? + DELIM_START.len();
        let end = output[start..].find(DELIM_END)? + start;
        let path = &output[start..end];
        path.split(':')
            .any(|entry| entry.starts_with('/'))
            .then_some(path)
    }

    /// Well-known per-user install locations followed by [`SYSTEM_DIRS`].
    /// Existence is checked by the caller so unit tests can inject temp dirs.
    fn fallback_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".bun/bin"));
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".cargo/bin"));
            dirs.push(home.join(".deno/bin"));
        }
        dirs.extend(SYSTEM_DIRS.iter().map(PathBuf::from));
        dirs
    }

    /// Ordered, deduplicated union: probed login-shell PATH first (it is the
    /// user's own ordering), then any inherited entries it lacks (never drop
    /// what we were launched with), then the existing fallback dirs.
    fn compose_path(probed: Option<&str>, inherited: &str, fallbacks: &[PathBuf]) -> String {
        let mut entries: Vec<PathBuf> = Vec::new();
        let push = |entry: PathBuf, entries: &mut Vec<PathBuf>| {
            if !entry.as_os_str().is_empty() && !entries.contains(&entry) {
                entries.push(entry);
            }
        };
        for entry in std::env::split_paths(probed.unwrap_or_default()) {
            push(entry, &mut entries);
        }
        for entry in std::env::split_paths(inherited) {
            push(entry, &mut entries);
        }
        for entry in fallbacks {
            push(entry.clone(), &mut entries);
        }
        std::env::join_paths(entries)
            .ok()
            .and_then(|joined| joined.into_string().ok())
            .unwrap_or_else(|| inherited.to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn compose_keeps_probed_order_and_appends_missing_inherited() {
            let out = compose_path(
                Some("/opt/homebrew/bin:/usr/bin:/bin"),
                "/usr/bin:/bin:/usr/sbin:/sbin",
                &[],
            );
            assert_eq!(out, "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        }

        #[test]
        fn compose_without_probe_preserves_inherited_and_adds_fallbacks() {
            let out = compose_path(
                None,
                "/usr/bin:/bin",
                &[
                    PathBuf::from("/opt/homebrew/bin"),
                    PathBuf::from("/usr/bin"),
                ],
            );
            assert_eq!(out, "/usr/bin:/bin:/opt/homebrew/bin");
        }

        #[test]
        fn compose_drops_duplicate_and_empty_entries() {
            let out = compose_path(Some("/a::/b:/a"), "/b:/c", &[]);
            assert_eq!(out, "/a:/b:/c");
        }

        #[test]
        fn extract_delimited_ignores_profile_noise() {
            let noisy = format!("motd banner\n{DELIM_START}/opt/homebrew/bin:/usr/bin{DELIM_END}");
            assert_eq!(
                extract_delimited(&noisy),
                Some("/opt/homebrew/bin:/usr/bin")
            );
        }

        #[test]
        fn extract_delimited_rejects_garbage() {
            assert_eq!(extract_delimited("no delimiters"), None);
            let relative = format!("{DELIM_START}not-a-path{DELIM_END}");
            assert_eq!(extract_delimited(&relative), None);
        }

        /// `fallback_dirs` reads the ambient `HOME`; the tests below assert
        /// the system tail and its ordering without mutating process env,
        /// which the in-process parallel harness would leak across tests.
        fn expected_home_dirs() -> Vec<PathBuf> {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| {
                    vec![
                        home.join(".bun/bin"),
                        home.join(".local/bin"),
                        home.join(".cargo/bin"),
                        home.join(".deno/bin"),
                    ]
                })
                .unwrap_or_default()
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn fallback_dirs_keep_the_macos_order() {
            let mut expected = expected_home_dirs();
            expected.push(PathBuf::from("/opt/homebrew/bin"));
            expected.push(PathBuf::from("/usr/local/bin"));
            assert_eq!(fallback_dirs(), expected);
        }

        #[cfg(target_os = "linux")]
        #[test]
        fn fallback_dirs_use_linux_locations() {
            let mut expected = expected_home_dirs();
            expected.push(PathBuf::from("/usr/local/bin"));
            expected.push(PathBuf::from("/snap/bin"));
            expected.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin"));
            assert_eq!(fallback_dirs(), expected);
            assert!(!fallback_dirs().contains(&PathBuf::from("/opt/homebrew/bin")));
        }

        #[test]
        fn existing_dir_filter_matches_caller_contract() {
            let tmp = tempfile::tempdir().expect("tempdir");
            let present = tmp.path().join("bin");
            std::fs::create_dir(&present).expect("mkdir");
            let missing = tmp.path().join("nope");
            let dirs: Vec<PathBuf> = [present.clone(), missing]
                .into_iter()
                .filter(|dir| dir.is_dir())
                .collect();
            assert_eq!(dirs, vec![present]);
        }
    }
}
