package gitx

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The real regression: `deno task dev` rewrote a tracked, compiled
// static/tailwind.css in minified form, an agent's own `git add -A && git
// commit` swallowed it, and every descendant thread branch inherited the 30k
// line reformat. Asserted on the COMMITTED TREE, not the index: the tree is
// what a pull request shows.
func TestPreCommitHookKeepsBuildArtifactsOutOfTheAgentsCommit(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	if err := os.MkdirAll(filepath.Join(repo, "static"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "static/tailwind.css", "/* expanded release build */\n")
	write(t, repo, "src/app.tsx", "export const A = 1\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "baseline")

	if err := InstallSandboxHooks(repo); err != nil {
		t.Fatal(err)
	}

	// A dev server minifies the CSS while the agent edits a component.
	write(t, repo, "static/tailwind.css", "*{margin:0}")
	write(t, repo, "src/app.tsx", "export const A = 2\n")
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "feat: bump A")

	changed := gitIn(t, repo, "show", "--stat", "--name-only", "--format=", "HEAD")
	if strings.Contains(changed, "static/tailwind.css") {
		t.Fatalf("the artifact reached the commit — every descendant branch inherits it:\n%s", changed)
	}
	if !strings.Contains(changed, "src/app.tsx") {
		t.Fatalf("the agent's actual change was dropped:\n%s", changed)
	}
	// Unstaged, not reverted: the file on disk is still the dev build, so the
	// running dev server is not yanked out from under itself.
	if got := read(t, repo, "static/tailwind.css"); got != "*{margin:0}" {
		t.Fatalf("hook modified the working tree: %q", got)
	}
}

func TestPreCommitHookLeavesDecofileBlocksAlone(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	if err := InstallSandboxHooks(repo); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, ".deco", "blocks"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, repo, ".deco/blocks/site.json", `{"hreflang":true}`)
	gitIn(t, repo, "add", "-A")
	gitIn(t, repo, "commit", "-q", "-m", "feat: site config")

	changed := gitIn(t, repo, "show", "--name-only", "--format=", "HEAD")
	if !strings.Contains(changed, ".deco/blocks/site.json") {
		t.Fatalf("decofile content is the point of many changes, not an artifact:\n%s", changed)
	}
}

// Publish pushes with --no-verify, so the hook alone is not enough.
func TestPublishDropsBuildArtifacts(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	if err := os.MkdirAll(filepath.Join(repo, "static"), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, repo, "static/tailwind.css", "*{margin:0}")
	write(t, repo, "src/app.tsx", "export const A = 1\n")

	// The push fails (no origin in a temp repo) — irrelevant here, the commit is
	// built first and the commit is what a pull request shows. A refusal to
	// commit at all would be a different error, so guard against that one.
	if err := Publish(PublishDeps{RepoDir: repo}, "autosave"); err != nil {
		var blocked *PublishBlockedError
		if errors.As(err, &blocked) {
			t.Fatalf("feature branch refused as protected: %v", err)
		}
	}
	changed := gitIn(t, repo, "show", "--name-only", "--format=", "HEAD")
	if strings.Contains(changed, "static/tailwind.css") {
		t.Fatalf("publish committed the artifact:\n%s", changed)
	}
	if !strings.Contains(changed, "src/app.tsx") {
		t.Fatalf("publish dropped the real change:\n%s", changed)
	}
}

func TestInstallSandboxHooksWritesTheArtifactList(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	if err := InstallSandboxHooks(repo); err != nil {
		t.Fatal(err)
	}
	hook := filepath.Join(repo, ".git", "hooks", "pre-commit")
	st, err := os.Stat(hook)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm()&0o111 == 0 {
		t.Fatal("pre-commit hook is not executable")
	}
	// Without the data file the hook exits 0 and silently guards nothing.
	list, err := os.ReadFile(filepath.Join(repo, ".git", "hooks", "build-artifacts"))
	if err != nil {
		t.Fatal("hook has no artifact list to read — it would guard nothing")
	}
	if string(list) != strings.Join(BuildArtifacts, "\n")+"\n" {
		t.Fatalf("artifact list: got %q", list)
	}
}

// InstallSandboxHooks used to overwrite pre-commit unconditionally, which
// silently dropped a repo's OWN pre-commit hook (lefthook, husky) on every
// reinstall — the format/lint check a maintainer relies on then never ran
// inside the sandbox at all.
func TestPreCommitHookStillRunsARepoOwnHook(t *testing.T) {
	repo := initRepoOnBranch(t, "feature/x")
	// Simulate lefthook/husky writing its own pre-commit hook (e.g. during a
	// postinstall step) before we install ours.
	localHook := "#!/bin/sh\necho blocked by local hook >&2\nexit 1\n"
	write(t, repo, ".git/hooks/pre-commit", localHook)
	if err := os.Chmod(filepath.Join(repo, ".git", "hooks", "pre-commit"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := InstallSandboxHooks(repo); err != nil {
		t.Fatal(err)
	}

	write(t, repo, "src/app.tsx", "export const A = 1\n")
	gitIn(t, repo, "add", "-A")
	cmd := exec.Command("git", "-C", repo, "commit", "-q", "-m", "feat: bump A")
	if err := cmd.Run(); err == nil {
		t.Fatal("commit should have been blocked by the repo's own pre-commit hook")
	}
}

func read(t *testing.T, repo, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(repo, rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
