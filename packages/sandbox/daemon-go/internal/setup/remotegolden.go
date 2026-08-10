package setup

// L2: the cross-node golden tier.
//
// The node-local golden (golden.go) only hits when the pod lands on a node
// already warm for its repo. The sandbox pool churns ~170 nodes a day across
// three AZs with ~80% fresh pods, so a large share of boots land somewhere cold
// and pay a full install, and cross-zone a node-local cache cannot help at all.
// This tier removes the same-node dependency: one archive per
// (repo, pm, lockfile) on a shared store, restorable on ANY node in ANY zone.
//
// ONE HARD RULE: a compressed ARCHIVE on the shared store, never the
// node_modules TREE. A shared store charges per-operation metadata latency —
// fatal across ~100k small files, a non-issue for a single large sequential
// blob. The per-file cost is paid by the local extract, on local disk. Mounting
// a tree here would be slower than no cache at all.
//
// The store is S3 through the mountpoint CSI driver, and this code assumes only
// that a path can be read and written sequentially. It does NOT assume rename
// or utimes, because mountpoint has neither — see PublishRemoteGolden for what
// losing rename costs, and pruneRemoteGoldens for why the bucket's own
// lifecycle policy is the real reaper.
//
// Dormant without GOLDEN_CACHE_REMOTE: absent → every entry point returns
// immediately and the boot path is exactly L1-then-install, as today.
//
// Ported from the TypeScript daemon's setup/remote-golden.ts, which was deleted
// with that daemon in #5575 before this tier ever ran in a deployed config.

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	remoteEnabledEnvVar = "GOLDEN_CACHE_REMOTE"
	remoteArchiveSuffix = ".tar.zst"
	// Longest single stderr line kept for a log message. A tar failure can
	// repeat per member, so this is a log line, not a transcript.
	remoteStderrMax = 200
)

// zstd level for publish. -3 is the speed/ratio knee: measured on a 2.3 GB /
// 168k-file tree it produced 450 MB in 26s, where -19 spent 85s to reach
// 332 MB. Publish is off the critical path but not free, and restore-side
// decompression is ~1.6s either way, so the extra 59s buys nothing that
// matters. -T0 uses all available cores.
var zstdPublishArgs = []string{"-3", "-T0"}

// RemoteGoldenParams identifies the shared archive for one install step. Mirrors
// GoldenParams so the orchestrator can derive one from the other — the two tiers
// are keyed identically on purpose (same credential-stripped repo hash, same
// lockfile hash), so they can never disagree about what a key means.
type RemoteGoldenParams struct {
	RemoteRoot  string
	CloneUrl    string
	InstallRoot string
	Pm          string
	Log         func(msg string)
}

func (p RemoteGoldenParams) log(msg string) {
	if p.Log != nil {
		p.Log(msg)
	}
}

// RemoteGoldenFrom derives the L2 params for an L1 golden, so a caller cannot
// accidentally key the two tiers differently.
func RemoteGoldenFrom(g GoldenParams) RemoteGoldenParams {
	return RemoteGoldenParams{
		CloneUrl:    g.CloneUrl,
		InstallRoot: g.InstallRoot,
		Pm:          g.Pm,
		Log:         g.Log,
	}
}

// RemoteEnabled is an independent kill switch, separate from
// GOLDEN_CACHE_ENABLED: L2 puts a shared store on the boot path and must be
// enableable — and revocable — without touching L1.
func RemoteEnabled() bool {
	return os.Getenv(remoteEnabledEnvVar) != ""
}

// RemoteGoldenArchivePath is the archive path for a (repo, pm, lockfile) triple,
// or empty when L2 cannot apply.
func RemoteGoldenArchivePath(remoteRoot, cloneUrl, pm, lockHash string) string {
	if remoteRoot == "" || cloneUrl == "" || lockHash == "" {
		return ""
	}
	return filepath.Join(remoteRoot, "golden", repoCacheKey(cloneUrl),
		pm+"-"+lockHash+remoteArchiveSuffix)
}

func (p RemoteGoldenParams) resolve() (string, bool) {
	if !RemoteEnabled() {
		return "", false
	}
	root := p.RemoteRoot
	if root == "" {
		root = os.Getenv(remoteEnabledEnvVar)
	}
	archive := RemoteGoldenArchivePath(root, p.CloneUrl, p.Pm,
		LockfileHash(p.InstallRoot, p.Pm))
	if archive == "" {
		return "", false
	}
	return archive, true
}

// pipeResult carries the exit code plus the first stderr line from either side.
// The message is the whole point: "tar exit 2" alone is unactionable — it took a
// hand-run of the pipe to learn it meant "Unexpected EOF in archive", i.e. a
// truncated archive rather than a permissions or disk problem.
type pipeResult struct {
	code   int
	stderr string
}

// runPiped streams producer | consumer to completion, reporting failure if
// EITHER side fails — the shell's `pipefail` semantics. Without that, a failed
// `tar -c` feeding a happy `zstd` would look like a successful publish.
//
// An explicit pipe rather than tar's own compressor flags, because those are not
// portable and fail in DIFFERENT ways per flavor: this image ships GNU tar, but
// a macOS host runner has bsdtar, where `-I` means `--include` (so `-I zstd`
// silently looks for a file named "zstd") and `--use-compress-program` is
// rejected on read with "Unrecognized archive format". `zstd -dc | tar -xf -`
// behaves identically everywhere.
//
// The kernel owns the pipe: os.Pipe gives both children one real fd pair, so a
// multi-GB tree never traverses this process. That matters twice — the daemon's
// health probe must keep answering while this runs (Studio tears the pod down on
// a single miss), and a relayed copy is what corrupted this transfer in the
// TypeScript version, where the runtime pumped the bytes through the event loop
// and raced the consumer. Using os/exec's StdoutPipe here would reintroduce
// exactly that relay.
func runPiped(producer, consumer *exec.Cmd) pipeResult {
	pr, pw, err := os.Pipe()
	if err != nil {
		return pipeResult{code: 1, stderr: err.Error()}
	}
	var perr, cerr bytes.Buffer
	producer.Stdout = pw
	producer.Stderr = &perr
	consumer.Stdin = pr
	consumer.Stderr = &cerr

	if err := producer.Start(); err != nil {
		pw.Close()
		pr.Close()
		return pipeResult{code: 1, stderr: err.Error()}
	}
	if err := consumer.Start(); err != nil {
		pw.Close()
		pr.Close()
		_ = producer.Wait()
		return pipeResult{code: 1, stderr: err.Error()}
	}
	// Drop the parent's ends: the consumer must see EOF when the producer exits,
	// which cannot happen while this process still holds the write side.
	pw.Close()
	pr.Close()

	prodErr := producer.Wait()
	consErr := consumer.Wait()

	// Consumer first: its message is the one that explains a corrupt archive.
	for _, c := range []struct {
		err error
		buf *bytes.Buffer
	}{{consErr, &cerr}, {prodErr, &perr}} {
		if c.err == nil {
			continue
		}
		code := 1
		var exitErr *exec.ExitError
		if errors.As(c.err, &exitErr) {
			code = exitErr.ExitCode()
		}
		return pipeResult{code: code, stderr: firstLine(c.buf.String())}
	}
	return pipeResult{code: 0}
}

func firstLine(s string) string {
	line := strings.TrimSpace(s)
	if i := strings.IndexByte(line, '\n'); i >= 0 {
		line = line[:i]
	}
	if len(line) > remoteStderrMax {
		line = line[:remoteStderrMax]
	}
	return line
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// TryRestoreRemoteGolden extracts the shared archive into the repo's
// node_modules, skipping install. True only when node_modules is now populated
// from the archive.
//
// Extraction lands in a staging dir and is then renamed into place. A tar
// interrupted halfway (pod killed, archive truncated) would otherwise leave a
// partial node_modules that later code reads as complete — the boot would skip
// install and fail later, somewhere unrelated.
func TryRestoreRemoteGolden(p RemoteGoldenParams) bool {
	archive, ok := p.resolve()
	if !ok || !fileExists(archive) {
		return false
	}

	target := filepath.Join(p.InstallRoot, "node_modules")
	staging := filepath.Join(p.InstallRoot, fmt.Sprintf(".node_modules.l2.%d", os.Getpid()))
	os.RemoveAll(staging)
	if err := os.MkdirAll(staging, 0o755); err != nil {
		p.log("[golden-l2] restore skipped: " + err.Error())
		return false
	}
	// The archive stores a `node_modules/` prefix, so it lands at
	// <staging>/node_modules.
	r := runPiped(
		exec.Command("zstd", "-dc", archive),
		exec.Command("tar", "-xf", "-", "-C", staging),
	)
	if r.code != 0 {
		p.log(fmt.Sprintf("[golden-l2] restore failed (exit %d: %s) — falling back to install", r.code, r.stderr))
		os.RemoveAll(staging)
		return false
	}
	// A partial tree from an interrupted earlier boot would make the rename land
	// inside it rather than replacing it.
	os.RemoveAll(target)
	if err := os.Rename(filepath.Join(staging, "node_modules"), target); err != nil {
		p.log("[golden-l2] restore skipped: " + err.Error())
		os.RemoveAll(staging)
		return false
	}
	os.RemoveAll(staging)

	// Best-effort recently-used marker. On a POSIX store this is what keeps a
	// TTL sweep from reaping a lockfile that repos are still booting on. On
	// mountpoint there is no utimes, so this fails and the bucket's lifecycle
	// policy is the only reaper — expiry counts from object creation there, so an
	// in-use archive does expire and the next boot republishes it.
	now := time.Now()
	os.Chtimes(archive, now, now)
	p.log("[golden-l2] restored node_modules from shared cache (skipped install)")
	return true
}

// PublishRemoteGolden publishes a node_modules as the shared archive for its
// lockfile.
//
// Callers must only invoke this for a boot whose dev server came up healthy —
// the same rule as L1, and it matters more here: a broken install published to
// the shared store poisons every node in the fleet, not just this one.
//
// Best-effort and idempotent: a no-op once the archive exists, and the archive
// is read back before this reports success, so a truncated write never survives
// as a permanently-broken key.
func PublishRemoteGolden(p RemoteGoldenParams) {
	archive, ok := p.resolve()
	if !ok {
		return
	}
	source := filepath.Join(p.InstallRoot, "node_modules")
	if !fileExists(source) {
		return
	}
	if fileExists(archive) {
		return // already published for this lockfile
	}
	// Best-effort: a blob store has no real directories, so creating the prefix
	// is a no-op there and may not be supported at all. Writing the key below is
	// what creates it.
	os.MkdirAll(filepath.Dir(archive), 0o755)

	// Written straight to its final key, NOT to a temp name plus rename. The
	// shared store is a blob store and rename does not exist there. Nothing is
	// lost by dropping it: an object becomes visible only once its upload
	// completes, so a publisher killed mid-write leaves no readable object —
	// the same guarantee the rename was providing.
	//
	// Porting this to a POSIX store would need the temp+rename back, because
	// there a partial file IS visible to a concurrent reader.
	tarArgs := []string{"-cf", "-", "-C", p.InstallRoot}
	for _, d := range runtimeCacheDirs {
		// Pod-local caches churn per boot and would bloat every download.
		tarArgs = append(tarArgs, "--exclude=node_modules/"+d)
	}
	tarArgs = append(tarArgs, "node_modules")

	zstdArgs := append(append([]string{}, zstdPublishArgs...), "-q", "-o", archive)
	if r := runPiped(exec.Command("tar", tarArgs...), exec.Command("zstd", zstdArgs...)); r.code != 0 {
		p.log(fmt.Sprintf("[golden-l2] publish failed (exit %d: %s)", r.code, r.stderr))
		os.Remove(archive)
		return
	}
	// A bad archive here is PERMANENT: publish no-ops once the key exists, so
	// every node in the fleet would keep failing its restore and paying a full
	// install, with nothing to repair it. Read it back and drop it if it does not
	// parse — publish already runs after the boot is healthy, off the critical
	// path, and this is one sequential pass.
	//
	// Because the write went to the live key, this reads back over the network
	// rather than off local disk. That is the cost of losing rename; it buys the
	// same protection, and the alternative — staging the archive in the pod
	// first — would spend the tenant's /app quota on a file that can be several
	// hundred MB.
	if check := runPiped(
		exec.Command("zstd", "-dc", archive),
		exec.Command("tar", "-tf", "-"),
	); check.code != 0 {
		p.log(fmt.Sprintf("[golden-l2] publish discarded — archive failed read-back (%s)", check.stderr))
		os.Remove(archive)
		return
	}
	p.log("[golden-l2] published node_modules to shared cache")
	pruneRemoteGoldens(p.remoteRootOrEnv(), GoldenTTL, GoldenMaxPerRepo, time.Now(), p.log)
}

func (p RemoteGoldenParams) remoteRootOrEnv() string {
	if p.RemoteRoot != "" {
		return p.RemoteRoot
	}
	return os.Getenv(remoteEnabledEnvVar)
}

// pruneRemoteGoldens bounds shared-store growth with the same rule as the
// node-local store: per repo, drop archives untouched for longer than the TTL,
// then keep only the newest maxPerRepo.
//
// Opportunistic (after a successful publish) and best-effort, so it only ever
// runs where publish does — i.e. wherever the store is writable. A tenant pod
// holds a read-only mount and cannot delete, which is the point. Racing a
// concurrent restore is safe: the reader either finished its extract or falls
// back to install.
//
// On mountpoint this prunes nothing useful, because there is no utimes for
// restore to touch and every archive's mtime is its creation time. The bucket
// lifecycle policy is the reaper there. Kept because it is correct on a POSIX
// store and free otherwise.
func pruneRemoteGoldens(remoteRoot string, ttl time.Duration, maxPerRepo int, now time.Time, log func(string)) {
	if remoteRoot == "" {
		return
	}
	root := filepath.Join(remoteRoot, "golden")
	repos, err := os.ReadDir(root)
	if err != nil {
		return // nothing published yet
	}
	for _, repo := range repos {
		repoDir := filepath.Join(root, repo.Name())
		names, err := os.ReadDir(repoDir)
		if err != nil {
			continue
		}
		type entry struct {
			path  string
			mtime time.Time
		}
		var entries []entry
		for _, name := range names {
			if !strings.HasSuffix(name.Name(), remoteArchiveSuffix) {
				continue
			}
			info, err := name.Info()
			if err != nil {
				continue
			}
			entries = append(entries, entry{filepath.Join(repoDir, name.Name()), info.ModTime()})
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].mtime.After(entries[j].mtime) })
		for i, e := range entries {
			if i >= maxPerRepo || now.Sub(e.mtime) > ttl {
				if err := os.Remove(e.path); err == nil && log != nil {
					log("[golden-l2] pruned " + e.path)
				}
			}
		}
	}
}
