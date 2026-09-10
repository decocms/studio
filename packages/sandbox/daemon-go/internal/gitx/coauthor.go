package gitx

import (
	"regexp"
	"strings"
)

type CoAuthorIdentity struct {
	UserName  string
	UserEmail string
}

var coAuthorInvalidChars = regexp.MustCompile(`[\r\n<>]`)
var coAuthorEmailRe = regexp.MustCompile(`^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$`)
var coAuthorTrailerRe = regexp.MustCompile(`(?i)^Co-authored-by:\s`)

func NormalizeCoAuthorIdentity(userName, userEmail string) *CoAuthorIdentity {
	name := strings.TrimSpace(userName)
	if name == "" || coAuthorInvalidChars.MatchString(name) {
		return nil
	}
	email := strings.TrimSpace(userEmail)
	if email == "" || coAuthorInvalidChars.MatchString(email) || !coAuthorEmailRe.MatchString(email) {
		return &CoAuthorIdentity{UserName: name}
	}
	return &CoAuthorIdentity{UserName: name, UserEmail: email}
}

func stripCoAuthorTrailers(message string) string {
	lines := strings.Split(message, "\n")
	kept := lines[:0]
	for _, l := range lines {
		if !coAuthorTrailerRe.MatchString(l) {
			kept = append(kept, l)
		}
	}
	return strings.TrimRight(strings.Join(kept, "\n"), " \t\r\n")
}

// CommitAttribution decides how a commit is attributed to the operator (the
// human who triggered it — the thread owner / publisher). Git's committer stays
// the configured bot identity; only the Author changes.
//
//   - operator has a valid name AND email → they become the git Author via
//     `--author`, and the now-redundant Co-authored-by trailer is dropped
//     (a commit authored by X should not also list X as a co-author).
//   - otherwise → we cannot form a valid `--author`, so we fall back to the
//     Co-authored-by trailer so attribution is never lost.
//
// Returns the (possibly rewritten) commit message and the extra `git commit`
// args to splice in before `-m` (empty when there is no valid author).
func CommitAttribution(message string, operator *CoAuthorIdentity) (msg string, authorArgs []string) {
	var normalized *CoAuthorIdentity
	if operator != nil {
		normalized = NormalizeCoAuthorIdentity(operator.UserName, operator.UserEmail)
	}
	if normalized != nil && normalized.UserEmail != "" {
		author := normalized.UserName + " <" + normalized.UserEmail + ">"
		return stripCoAuthorTrailers(message), []string{"--author", author}
	}
	return AppendCoAuthorTrailer(message, operator), nil
}

func AppendCoAuthorTrailer(message string, operator *CoAuthorIdentity) string {
	if operator == nil {
		return message
	}
	normalized := NormalizeCoAuthorIdentity(operator.UserName, operator.UserEmail)
	if normalized == nil {
		return message
	}
	withoutTrailers := stripCoAuthorTrailers(message)
	line := "Co-authored-by: " + normalized.UserName
	if normalized.UserEmail != "" {
		line = "Co-authored-by: " + normalized.UserName + " <" + normalized.UserEmail + ">"
	}
	if strings.Contains(withoutTrailers, line) {
		return withoutTrailers
	}
	trimmed := strings.TrimRight(withoutTrailers, " \t\r\n")
	if trimmed == "" {
		return line
	}
	return trimmed + "\n\n" + line
}
