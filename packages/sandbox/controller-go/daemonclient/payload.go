package daemonclient

import (
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strings"

	daemon "github.com/decocms/studio/sandbox-daemon/pkg/protocol"

	"github.com/decocms/studio/packages/sandbox/controller-go/protocol"
)

const defaultDevPort = 3000

// WorkloadConfig is the daemon /config body for a claim's options,
// shared by provision and warm-pool re-bootstrap so a recreated pod re-clones
// the same workload. opts nil (a row persisted without options) sends no
// cloneOnly at all.
//
// cloneOnly is dropped on a bound tenant-pool pod: its clone step would stop
// the dev task that makes the pod warm.
func WorkloadConfig(opts *protocol.EnsureOptions, tenantPoolPodBound bool) *daemon.TenantConfig {
	if opts == nil {
		return buildConfigPayload(payloadArgs{runtime: "node", port: defaultDevPort})
	}
	args := payloadArgs{
		runtime:    "node",
		repo:       opts.Repo,
		extraRepos: opts.ExtraRepos,
		port:       defaultDevPort,
		tenant:     opts.Tenant,
	}
	if w := opts.Workload; w != nil {
		if w.Runtime != "" {
			args.runtime = string(w.Runtime)
		}
		if w.PackageManager != "" {
			args.packageManager = &daemon.PackageManagerConfig{Name: daemon.Str(string(w.PackageManager))}
			if w.PackageManagerPath != "" {
				args.packageManager.Path = daemon.Str(w.PackageManagerPath)
			}
		}
		if w.DevPort != 0 {
			args.port = w.DevPort
		}
	}
	cloneOnly := opts.CloneOnly && !tenantPoolPodBound
	args.cloneOnly = &cloneOnly
	return buildConfigPayload(args)
}

type payloadArgs struct {
	runtime        string
	packageManager *daemon.PackageManagerConfig
	port           int
	repo           *protocol.EnsureRepo
	extraRepos     []protocol.EnsureRepo
	tenant         *protocol.Tenant
	cloneOnly      *bool
}

// buildConfigPayload collapses caller intent into the daemon's TenantConfig.
// nil when there is nothing to say. The daemon auto-starts the dev server
// when a runnable script is present, so nothing here asks it to.
func buildConfigPayload(args payloadArgs) *daemon.TenantConfig {
	cfg := &daemon.TenantConfig{}
	touched := false

	if repo := args.repo; repo != nil {
		repository := &daemon.GitRepository{
			CloneUrl: daemon.Str(repo.CloneURL),
			RepoName: daemon.Str(repoLabel(repo)),
			// Always sent, empty included: absent is "keep current" to the
			// daemon's merge, which would leave a revoked PAT live in the pod.
			SubmoduleCredentials: submoduleCredentials(repo.SubmoduleCredentials),
		}
		if repo.Branch != "" {
			repository.Branch = daemon.Str(repo.Branch)
		}
		git := &daemon.GitConfig{
			Repository: repository,
			// Empty included, same reason. The directory comes from the caller,
			// which shares it with TASK_ADD_REPO; one without it is dropped
			// rather than guessed at, or a checkout would move across a restart.
			Repositories: []daemon.GitRepository{},
		}
		for _, extra := range args.extraRepos {
			if extra.DirectoryName == "" {
				continue
			}
			r := daemon.GitRepository{
				CloneUrl:             daemon.Str(extra.CloneURL),
				RepoName:             daemon.Str(extra.DirectoryName),
				SubmoduleCredentials: submoduleCredentials(extra.SubmoduleCredentials),
			}
			if extra.Branch != "" {
				r.Branch = daemon.Str(extra.Branch)
			}
			git.Repositories = append(git.Repositories, r)
		}
		// Omitted without a user: a tenant warm pool bootstraps with a repo and
		// no author, and the daemon rejects a blank identity.
		if strings.TrimSpace(repo.UserName) != "" || strings.TrimSpace(repo.UserEmail) != "" {
			git.Identity = &daemon.GitIdentity{UserName: daemon.Str(repo.UserName), UserEmail: daemon.Str(repo.UserEmail)}
		}
		cfg.Git = git
		touched = true
	}

	if t := args.tenant; t != nil {
		if op := coAuthorIdentity(t.UserName, t.UserEmail); op != nil {
			cfg.Operator = op
			touched = true
		}
		// Provenance for artifacts that outlive the pod: the golden dependency
		// cache keys by org, because a repo hash does not isolate two orgs
		// cloning the same public template.
		if t.OrgID != "" {
			cfg.OrgId = t.OrgID
			touched = true
		}
	}

	if args.packageManager != nil {
		port := float64(args.port)
		cfg.Application = &daemon.Application{
			PackageManager: args.packageManager,
			Runtime:        daemon.Str(args.runtime),
			Port:           &port,
		}
		touched = true
	}

	// Sent whenever the caller said anything, false included: a pod reused
	// from a warm pool carries the previous claim's config.
	if args.cloneOnly != nil {
		v := *args.cloneOnly
		cfg.CloneOnly = &v
		touched = true
	}
	if !touched {
		return nil
	}
	return cfg
}

func submoduleCredentials(in []protocol.SubmoduleCredential) []daemon.SubmoduleCredential {
	out := make([]daemon.SubmoduleCredential, 0, len(in))
	for _, c := range in {
		out = append(out, daemon.SubmoduleCredential{Host: c.Host, Token: c.Token})
	}
	return out
}

var (
	invalidCoAuthorChars = regexp.MustCompile(`[\r\n<>]`)
	coAuthorEmail        = regexp.MustCompile(`^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$`)
)

// coAuthorIdentity mirrors normalizeCoAuthorIdentity in git-co-author.ts: no
// name, no operator; a bad email is dropped, not fatal.
func coAuthorIdentity(name, email string) *daemon.Operator {
	name = strings.TrimSpace(name)
	if name == "" || invalidCoAuthorChars.MatchString(name) {
		return nil
	}
	op := &daemon.Operator{UserName: daemon.Str(name)}
	email = strings.TrimSpace(email)
	if email != "" && !invalidCoAuthorChars.MatchString(email) && coAuthorEmail.MatchString(email) {
		op.UserEmail = daemon.Str(email)
	}
	return op
}

func repoLabel(repo *protocol.EnsureRepo) string {
	if repo.DisplayName != "" {
		return repo.DisplayName
	}
	u, err := url.Parse(repo.CloneURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return repo.CloneURL
	}
	trimmed := strings.TrimSuffix(strings.TrimLeft(u.Path, "/"), ".git")
	if trimmed == "" {
		return u.Hostname()
	}
	return trimmed
}

// cloneURLHasCredentials: the URL embeds a credential as userinfo.
func cloneURLHasCredentials(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.User != nil && u.User.Username() != ""
}

// CredentialRefreshPatch forwards only the credentialed clone URL: the
// daemon classifies same-repo + new-token as git-credential-refresh and
// rotates origin in place. Nil for a public clone: nothing to rotate.
func CredentialRefreshPatch(cloneURL string) *daemon.TenantConfig {
	if cloneURL == "" || !cloneURLHasCredentials(cloneURL) {
		return nil
	}
	return &daemon.TenantConfig{Git: &daemon.GitConfig{Repository: &daemon.GitRepository{CloneUrl: daemon.Str(cloneURL)}}}
}

// StripURLCredentials drops userinfo before a clone URL lands anywhere another
// reader can see it. Fails closed: an unparseable URL becomes "".
func StripURLCredentials(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	u.User = nil
	return u.String()
}

// Port is where the daemon listens inside the sandbox.
const Port = 9000

// reservedEnv are the bootstrap keys a caller's env must not shadow.
var reservedEnv = map[string]bool{"DAEMON_TOKEN": true, "DAEMON_BOOT_ID": true, "APP_ROOT": true, "PROXY_PORT": true}

// BootEnv is the daemon's boot environment: the caller's env with the
// bootstrap keys set over it, and the caller keys that were dropped for
// shadowing one, sorted.
func BootEnv(callerEnv map[string]string, token, bootID, workdir string) (map[string]string, []string) {
	out := map[string]string{}
	var dropped []string
	for k, v := range callerEnv {
		if reservedEnv[k] {
			dropped = append(dropped, k)
			continue
		}
		out[k] = v
	}
	sort.Strings(dropped)
	out["DAEMON_TOKEN"] = token
	out["DAEMON_BOOT_ID"] = bootID
	out["APP_ROOT"] = workdir
	out["PROXY_PORT"] = fmt.Sprint(Port)
	return out, dropped
}
