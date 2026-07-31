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
