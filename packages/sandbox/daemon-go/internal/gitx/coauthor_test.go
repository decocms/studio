package gitx

import (
	"reflect"
	"testing"
)

func TestCommitAttributionMakesOperatorTheAuthor(t *testing.T) {
	msg, args := CommitAttribution("Update from sandbox", &CoAuthorIdentity{
		UserName:  "Jane Doe",
		UserEmail: "jane@example.com",
	})
	if msg != "Update from sandbox" {
		t.Fatalf("message = %q, want unchanged", msg)
	}
	want := []string{"--author", "Jane Doe <jane@example.com>"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("authorArgs = %v, want %v", args, want)
	}
}

func TestCommitAttributionDropsRedundantTrailer(t *testing.T) {
	// A client-supplied trailer must not survive once the same person is the author.
	msg, args := CommitAttribution(
		"Publish\n\nCo-authored-by: Jane Doe <jane@example.com>",
		&CoAuthorIdentity{UserName: "Jane Doe", UserEmail: "jane@example.com"},
	)
	if msg != "Publish" {
		t.Fatalf("message = %q, want trailer stripped", msg)
	}
	if len(args) != 2 {
		t.Fatalf("authorArgs = %v, want --author set", args)
	}
}

func TestCommitAttributionFallsBackToTrailerWithoutEmail(t *testing.T) {
	msg, args := CommitAttribution("Update", &CoAuthorIdentity{UserName: "Jane Doe"})
	if args != nil {
		t.Fatalf("authorArgs = %v, want nil (no valid author)", args)
	}
	if msg != "Update\n\nCo-authored-by: Jane Doe" {
		t.Fatalf("message = %q, want co-author trailer fallback", msg)
	}
}

func TestCommitAttributionNoOperator(t *testing.T) {
	msg, args := CommitAttribution("Update", nil)
	if args != nil || msg != "Update" {
		t.Fatalf("CommitAttribution(nil) = (%q, %v), want (\"Update\", nil)", msg, args)
	}
}
