package gitx

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CommitSigning is the OpenSSH private key the sandbox signs commits with and
// the one committer it signs for. Both come from the pod environment
// (GIT_SIGNING_KEY_FILE, GIT_SIGNING_KEY_EMAIL — the sandbox-env chart's
// `commitSigning` values); either empty leaves commits unsigned.
//
// Only that committer's commits are signed. A forge verifies a signature
// against the committer's own account, so a human's commit signed with the
// bot's key renders as Unverified, which is worse than unsigned.
type CommitSigning struct {
	KeyFile string
	Email   string
}

func CommitSigningFromEnv() CommitSigning {
	return CommitSigning{
		KeyFile: os.Getenv("GIT_SIGNING_KEY_FILE"),
		Email:   os.Getenv("GIT_SIGNING_KEY_EMAIL"),
	}
}

func (s CommitSigning) appliesTo(userEmail string) bool {
	return s.KeyFile != "" && s.Email != "" &&
		strings.EqualFold(strings.TrimSpace(s.Email), strings.TrimSpace(userEmail))
}

// configureCommitSigning turns on SSH signing in the checkout's own git config,
// so every `git commit` in the sandbox — the daemon's publish and rebase as much
// as a harness's shell — is signed. The key is copied into the daemon's tmp dir
// (outside the repo, 0600, owned by the git uid) because ssh-keygen refuses a
// private key with looser permissions. `commit.gpgsign` is set last, so a
// failure before it leaves commits unsigned rather than failing.
func configureCommitSigning(repoDir, keyDir, userEmail string, s CommitSigning) error {
	if !s.appliesTo(userEmail) || keyDir == "" {
		return nil
	}
	key, err := os.ReadFile(s.KeyFile)
	if err != nil {
		return fmt.Errorf("read signing key: %w", err)
	}
	if !bytes.HasSuffix(key, []byte("\n")) {
		key = append(key, '\n')
	}
	keyPath := filepath.Join(keyDir, "commit-signing-key")
	// WriteFile's mode applies only on create, so a leftover keeps its old perms.
	os.Remove(keyPath)
	if err := os.WriteFile(keyPath, key, 0o600); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(keyPath, DecoUID, DecoGID); err != nil {
			return err
		}
	}
	for _, kv := range [][2]string{
		{"gpg.format", "ssh"},
		{"user.signingkey", keyPath},
		{"commit.gpgsign", "true"},
	} {
		if _, err := Run([]string{"config", kv[0], kv[1]}, RunOpts{Cwd: repoDir}); err != nil {
			return err
		}
	}
	return nil
}
