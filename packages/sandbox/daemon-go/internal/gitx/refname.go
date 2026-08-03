package gitx

import (
	"fmt"
	"regexp"
	"strings"
)

var remoteBranchNameRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9/._-]*$`)

type InvalidRemoteBranchNameError struct{ Name string }

func (e *InvalidRemoteBranchNameError) Error() string {
	return fmt.Sprintf("Invalid base branch name: %s", e.Name)
}

func AssertValidRemoteBranchName(name string) error {
	if name == "" ||
		len(name) > 255 ||
		strings.Contains(name, "..") ||
		strings.HasPrefix(name, "/") ||
		strings.HasSuffix(name, "/") ||
		strings.HasSuffix(name, ".lock") ||
		!remoteBranchNameRe.MatchString(name) {
		return &InvalidRemoteBranchNameError{Name: name}
	}
	return nil
}

var safeRefNameRe = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)

// IsSafeRefName is the conservative allowlist for ref names derived from
// remote-controlled output that reaches `sh -c` git commands.
func IsSafeRefName(name string) bool {
	return safeRefNameRe.MatchString(name) &&
		!strings.HasPrefix(name, "-") &&
		!strings.HasPrefix(name, "/") &&
		!strings.HasSuffix(name, "/") &&
		!strings.HasSuffix(name, ".lock") &&
		!strings.Contains(name, "..") &&
		!strings.Contains(name, "//")
}
