package routes

import (
	"net/http"
	"path/filepath"
	"strings"

	"github.com/decocms/studio/sandbox-daemon/internal/gitx"
	"github.com/decocms/studio/sandbox-daemon/internal/httpx"
	"github.com/decocms/studio/sandbox-daemon/internal/paths"
)

type GitDeps struct {
	AppRoot     string
	RepoDir     string
	GetCloneUrl func() string
	GetOperator func() *gitx.CoAuthorIdentity
}

func repoNotReady(w http.ResponseWriter) {
	httpx.JSON(w, 409, map[string]any{"error": "repository not initialized", "notReady": true})
}

func GitStatus(deps GitDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !gitx.IsGitRepo(deps.RepoDir) {
			repoNotReady(w)
			return
		}
		status, err := gitx.ComputeStatus(deps.RepoDir)
		if err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		httpx.JSON(w, 200, status)
	}
}

func GitDiff(deps GitDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !gitx.IsGitRepo(deps.RepoDir) {
			repoNotReady(w)
			return
		}
		var body struct {
			Base    string `json:"base"`
			HeadSha string `json:"headSha"`
		}
		if r.Method == "POST" {
			decodeBody(r, &body)
		}
		base := strings.TrimSpace(body.Base)
		headSha := strings.TrimSpace(body.HeadSha)

		var result gitx.DiffResult
		var err error
		if base != "" {
			result, err = gitx.ComputeDiffAgainstBase(deps.RepoDir, base, headSha)
		} else {
			result, err = gitx.ComputeDiff(deps.RepoDir)
		}
		if err != nil {
			if _, ok := err.(*gitx.InvalidRemoteBranchNameError); ok {
				httpx.Error(w, 400, err.Error())
				return
			}
			httpx.Error(w, 500, err.Error())
			return
		}
		httpx.JSON(w, 200, result)
	}
}

func GitPublish(deps GitDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !gitx.IsGitRepo(deps.RepoDir) {
			repoNotReady(w)
			return
		}
		var body struct {
			Message string `json:"message"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		err := gitx.Publish(gitx.PublishDeps{
			RepoDir:     deps.RepoDir,
			GetCloneUrl: deps.GetCloneUrl,
			GetOperator: deps.GetOperator,
		}, body.Message)
		if err != nil {
			httpx.Error(w, 500, gitx.FormatGitError(err))
			return
		}
		httpx.JSON(w, 200, map[string]any{"pushed": true})
	}
}

func GitDiscard(deps GitDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !gitx.IsGitRepo(deps.RepoDir) {
			repoNotReady(w)
			return
		}
		var body struct {
			Filepaths []string `json:"filepaths"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		if len(body.Filepaths) == 0 {
			httpx.Error(w, 400, "filepaths is required")
			return
		}
		validated := make([]string, 0, len(body.Filepaths))
		for _, fp := range body.Filepaths {
			rel, err := resolveRepoRelativePath(deps, fp)
			if err != nil {
				httpx.Error(w, 500, err.Error())
				return
			}
			validated = append(validated, rel)
		}
		if err := gitx.Discard(deps.RepoDir, validated); err != nil {
			httpx.Error(w, 500, err.Error())
			return
		}
		httpx.JSON(w, 200, map[string]any{"success": true})
	}
}

type invalidPathError struct{ path string }

func (e *invalidPathError) Error() string { return "Invalid path: " + e.path }

func resolveRepoRelativePath(deps GitDeps, userPath string) (string, error) {
	abs, ok := paths.SafePath(deps.AppRoot, deps.RepoDir, userPath)
	if !ok {
		return "", &invalidPathError{path: userPath}
	}
	rel, err := filepath.Rel(deps.RepoDir, abs)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", &invalidPathError{path: userPath}
	}
	return rel, nil
}

func GitRebase(deps GitDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !gitx.IsGitRepo(deps.RepoDir) {
			repoNotReady(w)
			return
		}
		var body struct {
			Base string `json:"base"`
		}
		if err := decodeBody(r, &body); err != nil {
			httpx.Error(w, 400, err.Error())
			return
		}
		base := strings.TrimSpace(body.Base)
		if base == "" {
			httpx.Error(w, 400, "base is required")
			return
		}
		var operator *gitx.CoAuthorIdentity
		if deps.GetOperator != nil {
			operator = deps.GetOperator()
		}
		if err := gitx.RebaseOntoBase(deps.RepoDir, base, operator); err != nil {
			if _, ok := err.(*gitx.InvalidRemoteBranchNameError); ok {
				httpx.Error(w, 400, err.Error())
				return
			}
			httpx.Error(w, 500, gitx.FormatGitError(err))
			return
		}
		httpx.JSON(w, 200, map[string]any{"rebased": true})
	}
}
