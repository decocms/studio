package gitx

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

type WorkingTreeStatus struct {
	NotAdded   []string        `json:"not_added"`
	Conflicted []string        `json:"conflicted"`
	Created    []string        `json:"created"`
	Deleted    []string        `json:"deleted"`
	Modified   []string        `json:"modified"`
	Renamed    []string        `json:"renamed"`
	Files      []PorcelainFile `json:"files"`
	Staged     []string        `json:"staged"`
	Ahead      int             `json:"ahead"`
	Behind     int             `json:"behind"`
	Current    *string         `json:"current"`
	Tracking   *string         `json:"tracking"`
	Detached   bool            `json:"detached"`
}

type StatusResult struct {
	WorkingTreeStatus
	BranchDivergence
}

func runReadGit(repoDir string, args []string) (string, error) {
	return Run(args, RunOpts{Cwd: repoDir, Env: ReadEnv(repoDir)})
}

func tryReadGit(repoDir string, args []string) (string, bool) {
	out, err := runReadGit(repoDir, args)
	if err != nil {
		return "", false
	}
	return out, true
}

func ComputeWorkingTreeStatus(repoDir string) (WorkingTreeStatus, error) {
	porcelain, err := runReadGit(repoDir, []string{"status", "--porcelain=v1", "-z"})
	if err != nil {
		return WorkingTreeStatus{}, err
	}
	files := ParsePorcelainFiles(porcelain)

	s := WorkingTreeStatus{
		NotAdded: []string{}, Conflicted: []string{}, Created: []string{},
		Deleted: []string{}, Modified: []string{}, Renamed: []string{},
		Files: files, Staged: []string{},
	}
	for _, f := range files {
		xy := f.Index + f.WorkingDir
		if strings.Contains(xy, "U") {
			s.Conflicted = append(s.Conflicted, f.Path)
		}
		switch {
		case f.Index == "?" && f.WorkingDir == "?":
			s.NotAdded = append(s.NotAdded, f.Path)
		case f.Index == "A" || f.WorkingDir == "A":
			s.Created = append(s.Created, f.Path)
		case f.Index == "D" || f.WorkingDir == "D":
			s.Deleted = append(s.Deleted, f.Path)
		case f.Index == "R" || f.WorkingDir == "R":
			s.Renamed = append(s.Renamed, f.Path)
		default:
			s.Modified = append(s.Modified, f.Path)
		}
		if f.Index != " " && f.Index != "?" {
			s.Staged = append(s.Staged, f.Path)
		}
	}

	if branch, ok := tryReadGit(repoDir, []string{"rev-parse", "--abbrev-ref", "HEAD"}); ok {
		s.Current = &branch
		s.Detached = branch == "HEAD"
	}
	if tracking, ok := tryReadGit(repoDir, []string{"rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"}); ok {
		s.Tracking = &tracking
	}

	if s.Tracking != nil && !s.Detached {
		counts, _ := tryReadGit(repoDir, []string{"rev-list", "--left-right", "--count", "@{upstream}...HEAD"})
		if m := regexp.MustCompile(`^(\d+)\s+(\d+)$`).FindStringSubmatch(counts); m != nil {
			s.Behind, _ = strconv.Atoi(m[1])
			s.Ahead, _ = strconv.Atoi(m[2])
		}
	}
	return s, nil
}

func ComputeStatus(repoDir string) (StatusResult, error) {
	working, err := ComputeWorkingTreeStatus(repoDir)
	if err != nil {
		return StatusResult{}, err
	}
	divergence := ComputeBranchDivergence(repoDir, func(args []string) (string, bool) {
		return tryReadGit(repoDir, args)
	})
	return StatusResult{WorkingTreeStatus: working, BranchDivergence: divergence}, nil
}

type DiffEntry struct {
	From *string `json:"from"`
	To   *string `json:"to"`
}

type DiffResult struct {
	Diffs        map[string]DiffEntry `json:"diffs"`
	MergeBaseSha string               `json:"mergeBaseSha,omitempty"`
}

func readRefFile(repoDir, ref, filePath string) *string {
	out, err := Run([]string{"show", ref + ":" + filePath}, RunOpts{Cwd: repoDir, Env: ReadEnv(repoDir)})
	if err != nil {
		return nil
	}
	return &out
}

func readWorkingFile(repoDir, filePath string) *string {
	raw, err := os.ReadFile(filepath.Join(repoDir, filePath))
	if err != nil {
		return nil
	}
	s := string(raw)
	return &s
}

func ComputeDiff(repoDir string) (DiffResult, error) {
	status, err := ComputeWorkingTreeStatus(repoDir)
	if err != nil {
		return DiffResult{}, err
	}
	diffs := map[string]DiffEntry{}
	seen := map[string]bool{}
	for _, f := range status.Files {
		if f.Path == "" || seen[f.Path] {
			continue
		}
		seen[f.Path] = true
		isDeleted := f.Index == "D" || f.WorkingDir == "D"
		head := readRefFile(repoDir, "HEAD", f.Path)
		isNew := (f.Index == "?" && f.WorkingDir == "?") ||
			f.Index == "A" || f.WorkingDir == "A" ||
			(head == nil && !isDeleted)
		entry := DiffEntry{}
		if !isNew {
			entry.From = head
		}
		if !isDeleted {
			entry.To = readWorkingFile(repoDir, f.Path)
		}
		diffs[f.Path] = entry
	}
	return DiffResult{Diffs: diffs}, nil
}

var fullShaRe = regexp.MustCompile(`^[0-9a-fA-F]{40}$`)

func ComputeDiffAgainstBase(repoDir, base, headSha string) (DiffResult, error) {
	if err := AssertValidRemoteBranchName(base); err != nil {
		return DiffResult{}, err
	}
	branch, ok := tryReadGit(repoDir, []string{"rev-parse", "--abbrev-ref", "HEAD"})
	if !ok || branch == "" || branch == "HEAD" {
		return DiffResult{}, &GitError{Msg: "Cannot compute PR diff from detached HEAD", Status: -1}
	}
	if err := AssertValidRemoteBranchName(branch); err != nil {
		return DiffResult{}, err
	}

	upstream := "origin/" + base
	remoteHead := "origin/" + branch
	hasValidHeadSha := headSha != "" && fullShaRe.MatchString(headSha)

	resolveLocally := func(ref string) bool {
		_, ok := tryReadGit(repoDir, []string{"rev-parse", "--verify", ref})
		return ok
	}

	var headRef string
	canSkipFetch := false
	if hasValidHeadSha && resolveLocally(upstream) && resolveLocally(headSha+"^{commit}") {
		if _, ok := tryReadGit(repoDir, []string{"merge-base", upstream, headSha}); ok {
			canSkipFetch = true
		}
	}
	if canSkipFetch {
		headRef = headSha
	} else {
		runReadGit(repoDir, []string{"fetch", "--depth", "100", "origin", base, branch})
		if hasValidHeadSha {
			tryReadGit(repoDir, []string{"fetch", "--depth", "100", "origin", headSha})
		}
		if !resolveLocally(upstream) {
			return DiffResult{}, &GitError{Msg: "Base branch '" + base + "' not found on origin", Status: -1}
		}
		switch {
		case hasValidHeadSha && resolveLocally(headSha+"^{commit}"):
			headRef = headSha
		case resolveLocally(remoteHead):
			headRef = remoteHead
		default:
			headRef = "HEAD"
		}
	}

	paths := listThreeDotDiffPaths(repoDir, upstream, headRef)
	if len(paths) == 0 && !canSkipFetch {
		runReadGit(repoDir, []string{"fetch", "--deepen", "500", "origin", base, branch})
		paths = listThreeDotDiffPaths(repoDir, upstream, headRef)
	}

	mergeBase, ok := tryReadGit(repoDir, []string{"merge-base", upstream, headRef})
	if !ok {
		mergeBase = upstream
	}

	diffs := map[string]DiffEntry{}
	for _, p := range paths {
		diffs[p] = DiffEntry{
			From: readRefFile(repoDir, mergeBase, p),
			To:   readRefFile(repoDir, headRef, p),
		}
	}
	return DiffResult{Diffs: diffs, MergeBaseSha: strings.TrimSpace(mergeBase)}, nil
}

func listThreeDotDiffPaths(repoDir, left, right string) []string {
	out, ok := tryReadGit(repoDir, []string{"diff", "--name-only", "-z", left + "..." + right})
	if !ok || out == "" {
		return nil
	}
	var paths []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" {
			paths = append(paths, p)
		}
	}
	return paths
}

var ansiColorRe = regexp.MustCompile("\x1b\\[[0-9;]*m")

func FormatGitError(err error) string {
	return ansiColorRe.ReplaceAllString(err.Error(), "")
}

// UntrackedUnder lists repo-relative paths under `pathspec` that git neither
// tracks nor ignores — i.e. what something newly wrote into the checkout. The
// `--exclude-standard` filter is what keeps daemon-planted paths out: they are
// already registered in `.git/info/exclude`.
func UntrackedUnder(repoDir, pathspec string) []string {
	out, ok := tryReadGit(repoDir, []string{
		"ls-files", "--others", "--exclude-standard", "--", pathspec,
	})
	if !ok {
		return nil
	}
	var paths []string
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		if line != "" {
			paths = append(paths, line)
		}
	}
	return paths
}
