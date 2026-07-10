package paths

import (
	"os"
	"path/filepath"
	"strings"
)

func SafePath(workspaceRoot, baseDir, userPath string) (string, bool) {
	var resolved string
	if filepath.IsAbs(userPath) {
		resolved = filepath.Clean(userPath)
	} else {
		resolved = filepath.Join(baseDir, userPath)
	}
	if resolved != workspaceRoot && !strings.HasPrefix(resolved, workspaceRoot+string(filepath.Separator)) {
		return "", false
	}
	return resolved, true
}

func ResolvePmRoot(repoDir, pmPath string) string {
	if pmPath == "" {
		return repoDir
	}
	if filepath.IsAbs(pmPath) {
		return pmPath
	}
	return filepath.Join(repoDir, pmPath)
}

func AppLogPath(logsDir, name string) string {
	return filepath.Join(logsDir, "app", name)
}

func HasGitRepo(repoDir string) bool {
	_, err := os.Stat(filepath.Join(repoDir, ".git"))
	return err == nil
}
