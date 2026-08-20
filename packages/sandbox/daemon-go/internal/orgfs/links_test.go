package orgfs

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The end-to-end behavior lives in daemon.orgfs.e2e.test.ts. Here: the one
// invariant that suite cannot see — the memo must never cache a failed repoint.
func TestRepointDoesNotCacheAFailedLink(t *testing.T) {
	appRoot := t.TempDir()
	statusPath := filepath.Join(t.TempDir(), "status.json")
	writeStatus := func(dirs ...string) {
		var mounts []Mount
		for _, d := range dirs {
			p := filepath.Join(appRoot, "org", d)
			if err := os.MkdirAll(p, 0o755); err != nil {
				t.Fatal(err)
			}
			mounts = append(mounts, Mount{Volume: d, MountPath: p})
		}
		raw, _ := json.Marshal(sidecarStatus{Mounts: mounts})
		if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	l := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}

	// The outputs volume is not mounted yet — a sandbox provisioned before it
	// existed, or a sidecar still attaching.
	writeStatus(".uploads")
	if l.RepointForRun("t1") {
		t.Fatal("reported a repoint with no outputs mount")
	}
	if _, err := os.Lstat(filepath.Join(appRoot, "org", "output")); err == nil {
		t.Fatal("linked output into an unmounted volume")
	}

	// It appears. Had the failure been memoized, this would return true without
	// creating the link, and every write for this thread would go nowhere.
	writeStatus(".uploads", ".outputs")
	if !l.RepointForRun("t1") {
		t.Fatal("did not repoint once the outputs volume was mounted")
	}
	target, err := os.Readlink(filepath.Join(appRoot, "org", "output"))
	if err != nil {
		t.Fatalf("no output link after a reported repoint: %v", err)
	}
	if want := filepath.Join(".outputs", "t1"); target != want {
		t.Errorf("output → %q, want %q", target, want)
	}
}

// A write that lands before the first repoint materializes a REAL `org/output`
// on ephemeral disk (the fs write route MkdirAlls its parent). An empty one
// must be healed — replaced by the link — or the mount stays shadowed for the
// pod's whole life. A populated one holds agent bytes and must be left alone.
func TestRepointHealsAnEmptyRealOutputDir(t *testing.T) {
	appRoot := t.TempDir()
	statusPath := filepath.Join(t.TempDir(), "status.json")
	mountPath := filepath.Join(appRoot, "org", ".outputs")
	if err := os.MkdirAll(mountPath, 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(sidecarStatus{Mounts: []Mount{{Volume: ".outputs", MountPath: mountPath}}})
	if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	l := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}

	// Empty real dir in the link's place: healed.
	link := filepath.Join(appRoot, "org", "output")
	if err := os.MkdirAll(link, 0o755); err != nil {
		t.Fatal(err)
	}
	if !l.RepointForRun("t1") {
		t.Fatal("did not heal an empty real org/output dir")
	}
	if target, err := os.Readlink(link); err != nil || target != filepath.Join(".outputs", "t1") {
		t.Fatalf("output link = %q (err %v), want .outputs/t1", target, err)
	}

	// Populated real dir: agent bytes, never discarded.
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(link, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(link, "plan.md"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if l.RepointForRun("t2") {
		t.Fatal("reported a repoint over a populated real org/output dir")
	}
	if _, err := os.Stat(filepath.Join(link, "plan.md")); err != nil {
		t.Fatalf("populated dir was discarded: %v", err)
	}
}

func TestExpectedRequiresSidecarEnv(t *testing.T) {
	if (&Links{}).Expected() {
		t.Error("org-fs expected with no sidecar env — every call would pay the mount wait")
	}
	if !(&Links{ConfigPath: "/run/orgfs/config.json"}).Expected() {
		t.Error("a relay config path alone must mark org-fs expected")
	}
	var nilLinks *Links
	if nilLinks.Expected() {
		t.Error("nil Links reported org-fs expected")
	}
}

// The skills link is what makes an org skill both readable by Claude Code and
// durable when the agent writes one. Three invariants no mount-level test sees:
// an unmounted mount point is never linked (MkdirAll would put the org's skills
// on ephemeral disk), an EMPTY dir is linked without probing (it is the agent's
// only durable place to write a skill, and there is no file to hang on), and a
// POPULATED dir that does not read is not linked (Claude Code reads it during
// startup, so a hung read there kills the run).
func TestSkillsLinkNeedsAMountThatWorks(t *testing.T) {
	appRoot := t.TempDir()
	configDir := filepath.Join(t.TempDir(), "config")
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	statusPath := filepath.Join(t.TempDir(), "status.json")
	link := filepath.Join(configDir, "skills")
	homeMount := filepath.Join(appRoot, "org", "home")
	skillsDir := filepath.Join(homeMount, "skills")
	if err := os.MkdirAll(homeMount, 0o755); err != nil {
		t.Fatal(err)
	}
	setMounts := func(mounts ...Mount) {
		raw, _ := json.Marshal(sidecarStatus{Mounts: mounts})
		if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// Mount point present, sidecar reporting nothing mounted there.
	setMounts(Mount{Volume: "outputs", MountPath: filepath.Join(appRoot, "org", ".outputs")})

	l := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}
	l.ensureSkillsLinkLocked()
	if _, err := os.Lstat(link); err == nil {
		t.Fatal("linked an unmounted mount point — the skills would die with the pod")
	}

	// Mounted and empty: linked with no probe, so the agent has somewhere durable
	// to write even while the backend's reads are wedged.
	setMounts(Mount{Volume: "home", MountPath: homeMount})
	l.ensureSkillsLinkLocked()
	target, err := os.Readlink(link)
	if err != nil {
		t.Fatalf("empty skills dir not linked — the agent would write to the repo: %v", err)
	}
	if target != skillsDir {
		t.Errorf("skills → %q, want %q", target, skillsDir)
	}

	// Populated but unreadable: not linked. A SKILL.md that exists (stat, served
	// from mount metadata) but cannot be read is exactly the wedged-backend shape.
	// Fresh Links — the first one memoized its success.
	if err := os.MkdirAll(filepath.Join(skillsDir, "wedged"), 0o755); err != nil {
		t.Fatal(err)
	}
	wedgedSkill := filepath.Join(skillsDir, "wedged", "SKILL.md")
	if err := os.WriteFile(wedgedSkill, []byte("---\nname: w\n---\n"), 0o000); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	unreadable := &Links{AppRoot: appRoot, StatusPath: statusPath, ConfigPath: "unused"}
	unreadable.ensureSkillsLinkLocked() // no SKILL.md in `wedged` → read fails
	if _, err := os.Lstat(link); err == nil {
		t.Fatal("linked a populated dir whose skill does not read — startup would hang")
	}
	if unreadable.skillsLinked {
		t.Fatal("memoized a failed link; a recovered mount would never be picked up")
	}

	// Populated and readable: linked.
	if err := os.Chmod(wedgedSkill, 0o644); err != nil {
		t.Fatal(err)
	}
	unreadable.ensureSkillsLinkLocked()
	if _, err := os.Readlink(link); err != nil {
		t.Errorf("healthy populated dir not linked: %v", err)
	}
}

// A pod that ships its own skills dir keeps it — org skills are additive.
func TestSkillsLinkNeverShadowsARealDir(t *testing.T) {
	appRoot := t.TempDir()
	configDir := filepath.Join(t.TempDir(), "config")
	t.Setenv("CLAUDE_CONFIG_DIR", configDir)
	if err := os.MkdirAll(filepath.Join(configDir, "skills", "builtin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(appRoot, "org", "home"), 0o755); err != nil {
		t.Fatal(err)
	}

	(&Links{AppRoot: appRoot, ConfigPath: "unused"}).ensureSkillsLinkLocked()
	if _, err := os.Stat(filepath.Join(configDir, "skills", "builtin")); err != nil {
		t.Errorf("replaced the pod's own skills dir: %v", err)
	}
}

// Public sets are where an org's curated skills actually live, and they mount
// read-only — so they reach Claude Code as project skills in the checkout. The
// invariants: the repo's own skills survive, ours are rebuilt (no dangling
// symlink when a set loses a skill), and they never reach a commit.
func TestPublicSkillLinks(t *testing.T) {
	appRoot := t.TempDir()
	repoDir := filepath.Join(appRoot, "repo")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(t.TempDir(), "config"))
	writeSkill := func(set, skill string) {
		dir := filepath.Join(appRoot, "org", "public", set, skill)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: x\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// The repo ships a skill of its own, and a dir that is not a skill at all.
	ownSkill := filepath.Join(repoDir, ".claude", "skills", "repo-own")
	if err := os.MkdirAll(ownSkill, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repoDir, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeSkill("core", "slides")
	writeSkill("core", "pdf")
	if err := os.MkdirAll(filepath.Join(appRoot, "org", "public", "core", "not-a-skill"), 0o755); err != nil {
		t.Fatal(err)
	}

	l := &Links{AppRoot: appRoot, RepoDir: repoDir, ConfigPath: "unused"}
	l.syncPublicSkills()

	skillsDir := filepath.Join(repoDir, ".claude", "skills")
	target, err := os.Readlink(filepath.Join(skillsDir, "orgfs-core-slides"))
	if err != nil {
		t.Fatalf("public skill not linked: %v", err)
	}
	if want := filepath.Join(appRoot, "org", "public", "core", "slides"); target != want {
		t.Errorf("link → %q, want %q", target, want)
	}
	if _, err := os.Lstat(filepath.Join(skillsDir, "orgfs-core-not-a-skill")); err == nil {
		t.Error("linked a directory with no SKILL.md")
	}
	if _, err := os.Stat(ownSkill); err != nil {
		t.Errorf("clobbered the repo's own skill: %v", err)
	}

	excl, err := os.ReadFile(filepath.Join(repoDir, ".git", "info", "exclude"))
	if err != nil || !strings.Contains(string(excl), "/.claude/skills/orgfs-*") {
		t.Errorf("links not git-excluded — a run would commit them: %q %v", excl, err)
	}

	// A rebuild after `pdf` disappeared must not leave it dangling.
	if err := os.RemoveAll(filepath.Join(appRoot, "org", "public", "core", "pdf")); err != nil {
		t.Fatal(err)
	}
	l.publicSkillsRun = false
	l.syncPublicSkills()
	if _, err := os.Lstat(filepath.Join(skillsDir, "orgfs-core-pdf")); err == nil {
		t.Error("stale symlink kept for a skill that no longer exists")
	}
	if _, err := os.Readlink(filepath.Join(skillsDir, "orgfs-core-slides")); err != nil {
		t.Errorf("rebuild dropped a live skill: %v", err)
	}
}

func TestSyncedVolumeSkillLinks(t *testing.T) {
	appRoot := t.TempDir()
	repoDir := filepath.Join(appRoot, "repo")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(t.TempDir(), "config"))
	statusPath := filepath.Join(t.TempDir(), "status.json")
	if err := os.MkdirAll(filepath.Join(repoDir, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A repo-sync volume mounts at `org/<volume>`; home and the hidden per-thread
	// volumes mount alongside it and must NOT be scanned for skills.
	for _, dir := range []string{"decocms-skills/unslopify", "home/skills/mine", ".outputs/t1"} {
		if err := os.MkdirAll(filepath.Join(appRoot, "org", dir), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(
			filepath.Join(appRoot, "org", dir, "SKILL.md"), []byte("---\nname: x\n---\n"), 0o644,
		); err != nil {
			t.Fatal(err)
		}
	}
	raw, _ := json.Marshal(sidecarStatus{Mounts: []Mount{
		{Volume: "decocms-skills", MountPath: filepath.Join(appRoot, "org", "decocms-skills")},
		{Volume: "home", MountPath: filepath.Join(appRoot, "org", "home")},
		{Volume: "outputs", MountPath: filepath.Join(appRoot, "org", ".outputs")},
	}})
	if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	l := &Links{AppRoot: appRoot, RepoDir: repoDir, StatusPath: statusPath, ConfigPath: "unused"}
	l.syncPublicSkills()

	skillsDir := filepath.Join(repoDir, ".claude", "skills")
	target, err := os.Readlink(filepath.Join(skillsDir, "orgfs-decocms-skills-unslopify"))
	if err != nil {
		t.Fatalf("synced-repo skill not linked: %v", err)
	}
	if want := filepath.Join(appRoot, "org", "decocms-skills", "unslopify"); target != want {
		t.Errorf("link → %q, want %q", target, want)
	}
	for _, name := range []string{"orgfs-home-skills", "orgfs-.outputs-t1"} {
		if _, err := os.Lstat(filepath.Join(skillsDir, name)); err == nil {
			t.Errorf("linked a non-skill-set volume: %s", name)
		}
	}
}

// A set whose FIRST skill is unreadable must still expose the rest — the failure
// belongs to that object, not to the mount.
func TestUnreadableSkillDoesNotCondemnSet(t *testing.T) {
	appRoot := t.TempDir()
	repoDir := filepath.Join(appRoot, "repo")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(t.TempDir(), "config"))
	if err := os.MkdirAll(filepath.Join(repoDir, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}
	setDir := filepath.Join(appRoot, "org", "public", "core")
	// "aaa-broken" sorts first, so it is the probe the old code condemned on. Its
	// SKILL.md is a DIRECTORY: `skillDirNames` still picks the skill up (that is a
	// stat, which passes) and the read then fails immediately — the EIO shape, not
	// a hang. A directory rather than a chmod so the case holds as root too.
	if err := os.MkdirAll(filepath.Join(setDir, "aaa-broken", "SKILL.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(setDir, "slides"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(setDir, "slides", "SKILL.md"), []byte("---\nname: x\n---\n"), 0o644,
	); err != nil {
		t.Fatal(err)
	}

	l := &Links{AppRoot: appRoot, RepoDir: repoDir, ConfigPath: "unused"}
	if !l.syncPublicSkills() {
		t.Fatal("set condemned by one unreadable skill")
	}
	if _, err := os.Readlink(filepath.Join(repoDir, ".claude", "skills", "orgfs-core-slides")); err != nil {
		t.Errorf("healthy skill behind the bad probe was not linked: %v", err)
	}
}

func TestWaitSkillLinks(t *testing.T) {
	appRoot := t.TempDir()
	repoDir := filepath.Join(appRoot, "repo")
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(t.TempDir(), "config"))
	skill := filepath.Join(appRoot, "org", "public", "core", "slides")
	if err := os.MkdirAll(skill, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skill, "SKILL.md"), []byte("---\nname: x\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repoDir, ".git", "info"), 0o755); err != nil {
		t.Fatal(err)
	}

	l := &Links{AppRoot: appRoot, RepoDir: repoDir, ConfigPath: "unused"}
	// No sync started yet — the waiter must not block.
	l.WaitSkillLinks(time.Second)

	l.mu.Lock()
	l.ensurePublicSkillLinksLocked()
	l.mu.Unlock()
	// The whole point: after this returns the links are on disk, so the harness's
	// one-shot startup scan cannot miss them.
	l.WaitSkillLinks(10 * time.Second)
	if _, err := os.Readlink(filepath.Join(repoDir, ".claude", "skills", "orgfs-core-slides")); err != nil {
		t.Errorf("WaitSkillLinks returned before the link landed: %v", err)
	}
}

func TestAdoptStrayRepoSkills(t *testing.T) {
	appRoot := t.TempDir()
	repoDir := filepath.Join(appRoot, "repo")
	statusPath := filepath.Join(t.TempDir(), "status.json")
	homeMount := filepath.Join(appRoot, "org", "home")
	if err := os.MkdirAll(filepath.Join(homeMount, "skills"), 0o755); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(sidecarStatus{Mounts: []Mount{
		{Volume: "home", MountPath: homeMount},
	}})
	if err := os.WriteFile(statusPath, raw, 0o644); err != nil {
		t.Fatal(err)
	}

	writeSkill := func(name, body string) string {
		dir := filepath.Join(repoDir, ".claude", "skills", name)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		return dir
	}
	git := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repoDir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	// A committed skill (the repo legitimately owns it) and a dir with no
	// SKILL.md, both of which must survive untouched.
	tracked := writeSkill("repo-own", "---\nname: repo-own\n---\n")
	if err := os.MkdirAll(filepath.Join(repoDir, ".claude", "skills", "junk"), 0o755); err != nil {
		t.Fatal(err)
	}
	git("init", "-q")
	git("config", "user.email", "t@t.t")
	git("config", "user.name", "t")
	git("add", "-A")
	git("commit", "-qm", "init")

	// What the model actually did: authored a skill into the checkout, with a
	// nested file, where it would die with the branch.
	stray := writeSkill("rubber-duck", "---\nname: rubber-duck\n---\nquack\n")
	if err := os.WriteFile(filepath.Join(stray, "notes.md"), []byte("more"), 0o644); err != nil {
		t.Fatal(err)
	}

	l := &Links{AppRoot: appRoot, RepoDir: repoDir, StatusPath: statusPath, ConfigPath: "unused"}
	l.AdoptStrayRepoSkills()

	adopted := filepath.Join(homeMount, "skills", "rubber-duck")
	body, err := os.ReadFile(filepath.Join(adopted, "SKILL.md"))
	if err != nil {
		t.Fatalf("stray skill not adopted onto the mount: %v", err)
	}
	if !strings.Contains(string(body), "quack") {
		t.Errorf("adopted the wrong bytes: %q", body)
	}
	if _, err := os.Stat(filepath.Join(adopted, "notes.md")); err != nil {
		t.Errorf("nested file lost in the move: %v", err)
	}
	if _, err := os.Stat(stray); err == nil {
		t.Error("left the skill in the checkout too — the next commit ships it")
	}
	if _, err := os.Stat(filepath.Join(tracked, "SKILL.md")); err != nil {
		t.Errorf("moved a skill the repo owns: %v", err)
	}
	if _, err := os.Stat(filepath.Join(homeMount, "skills", "junk")); err == nil {
		t.Error("adopted a directory with no SKILL.md")
	}

	// A name the org already uses is left alone rather than overwritten.
	stray2 := writeSkill("rubber-duck", "---\nname: mine\n---\nlocal\n")
	l.AdoptStrayRepoSkills()
	if _, err := os.Stat(stray2); err != nil {
		t.Error("deleted a stray skill without adopting it")
	}
	if body, _ := os.ReadFile(filepath.Join(adopted, "SKILL.md")); !strings.Contains(string(body), "quack") {
		t.Error("clobbered the org's skill with a same-named local one")
	}
}
