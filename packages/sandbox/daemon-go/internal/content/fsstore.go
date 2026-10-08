package content

// The filesystem storage, ported from `@decocms/blocks/protocol/storage/fs`
// (index.ts, hash.ts, lock.ts, transaction.ts). Inside the app root:
//
//   - .deco/blocks/*.json — the saved blocks; the only thing a commit writes;
//   - .deco/schema.gen.json, else .deco/meta.gen.json — read only;
//   - .deco/secrets.pub — read only;
//   - public/assets — uploads, never overwriting a file.
//
// A file's version is its git blob hash. Commits are serialized in process and
// across processes (.deco/.blocks.lock), applied with staged files and atomic
// renames, rolled back on failure, and the folder is fsynced before a commit
// returns. A crashed commit can leave .deco/.blocks.lock (taken over after
// 30 s) and .deco/.tx-* folders (swept by the next commit) behind.

import (
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultAssetsDir      = "public/assets"
	DefaultAssetsMaxBytes = 25 * 1024 * 1024
	lockFileName          = ".blocks.lock"
	transactionPrefix     = ".tx-"
)

// storageNotFound: there's no .deco folder at all.
type storageNotFound struct{ msg string }

func (e *storageNotFound) Error() string { return e.msg }

// storageInvalidFile: a name that can't be a saved-block file.
type storageInvalidFile struct{ file string }

func (e *storageInvalidFile) Error() string { return "not a saved-block file name: " + e.file }

// storageUnavailable: the storage failed or is busy.
type storageUnavailable struct {
	msg          string
	retryAfterMs int // -1: none
}

func (e *storageUnavailable) Error() string { return e.msg }

// storageFile is one saved-block file in a snapshot.
type storageFile struct {
	File    string
	Version string
	Size    int64
}

type storageSnapshot struct {
	Revision string
	Files    []storageFile
}

type storedBody struct {
	Text    string
	Version string
}

type storedSchema struct {
	Version string
	Text    string
}

type filePut struct {
	File    string
	Content string
}

type commitAttempt struct {
	Put      []filePut
	Delete   []string
	Expected map[string]*string // nil value: must not exist
	// ExpectedSchemaVersion is checked when CheckSchema is set (nil: no schema).
	CheckSchema           bool
	ExpectedSchemaVersion *string
}

type commitResult struct {
	Stale    bool
	Revision string
	Versions map[string]string
}

// FSOptions configure a filesystem storage.
type FSOptions struct {
	// Root is the app root: the folder that contains .deco/.
	Root string
	// RepoRoot is what describe reports paths relative to.
	RepoRoot string
	// AssetsMaxBytes is the largest upload (default 25 MiB).
	AssetsMaxBytes int64
	// LockTimeout bounds the wait for another process's lock (default 10 s).
	LockTimeout time.Duration
	// ContainWithin, when set, refuses (as NotFound) to read or write when
	// .deco, .deco/blocks or the assets folder resolve, through symlinks,
	// outside it.
	// OPEN: stricter than the TS FS storage, which follows symlinks.
	ContainWithin string
	// Exclusive, when set, is held around every commit and upload (the daemon's
	// working-tree lock), before the in-process and file locks. ok false means
	// it couldn't be had in time: the write is refused as Unavailable (retry),
	// never left to land after the client gave up.
	Exclusive func() (release func(), ok bool)
}

type fingerprinted struct {
	fingerprint string
	version     string
}

// FSStore is the filesystem storage of one app root.
type FSStore struct {
	root, repoRoot, decoDir, blocksDir, assetsDir string
	assetsMaxBytes                                int64
	lockTimeout, lockStale                        time.Duration
	exclusive                                     func() (func(), bool)
	containWithin                                 string

	hashMu    sync.Mutex
	hashCache map[string]fingerprinted

	commitMu sync.Mutex // the in-process commit queue
	swept    bool
}

// NewFSStore opens the storage of an app root.
func NewFSStore(o FSOptions) *FSStore {
	root, _ := filepath.Abs(o.Root)
	repoRoot := o.RepoRoot
	if repoRoot == "" {
		repoRoot = root
	}
	repoRoot, _ = filepath.Abs(repoRoot)
	s := &FSStore{
		root:           root,
		repoRoot:       repoRoot,
		decoDir:        filepath.Join(root, ".deco"),
		blocksDir:      filepath.Join(root, ".deco", "blocks"),
		assetsDir:      filepath.Join(root, filepath.FromSlash(defaultAssetsDir)),
		assetsMaxBytes: o.AssetsMaxBytes,
		lockTimeout:    o.LockTimeout,
		lockStale:      30 * time.Second,
		exclusive:      o.Exclusive,
		containWithin:  o.ContainWithin,
		hashCache:      map[string]fingerprinted{},
	}
	if s.assetsMaxBytes <= 0 {
		s.assetsMaxBytes = DefaultAssetsMaxBytes
	}
	if s.lockTimeout <= 0 {
		s.lockTimeout = 10 * time.Second
	}
	return s
}

// checkContained answers storageNotFound when a storage folder resolves
// outside ContainWithin (see FSOptions).
func (s *FSStore) checkContained() error {
	if s.containWithin == "" {
		return nil
	}
	within, err := resolveExisting(s.containWithin)
	if err != nil {
		return wrapIOError(err)
	}
	for _, dir := range []string{s.decoDir, s.blocksDir, s.assetsDir} {
		real, err := resolveExisting(dir)
		if err != nil {
			return wrapIOError(err)
		}
		rel, err := filepath.Rel(within, real)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return &storageNotFound{msg: dir + " resolves outside " + s.containWithin}
		}
	}
	return nil
}

// resolveExisting resolves the symlinks of path's longest existing prefix
// and appends the rest (what a later MkdirAll would create).
func resolveExisting(path string) (string, error) {
	path = filepath.Clean(path)
	rest := ""
	for {
		real, err := filepath.EvalSymlinks(path)
		if err == nil {
			return filepath.Join(real, rest), nil
		}
		if !isMissing(err) {
			return "", err
		}
		parent := filepath.Dir(path)
		if parent == path {
			return filepath.Join(path, rest), nil
		}
		rest = filepath.Join(filepath.Base(path), rest)
		path = parent
	}
}

// Root is the absolute app root.
func (s *FSStore) Root() string { return s.root }

func isMissing(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR)
}

func exists(path string) (bool, error) {
	if _, err := os.Lstat(path); err != nil {
		if isMissing(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func readBytesOrNil(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		return nil, err
	}
	return b, nil
}

// gitBlobHash is `git hash-object`: sha1("blob <size>\0" + bytes).
func gitBlobHash(b []byte) string {
	h := sha1.New()
	h.Write([]byte("blob " + strconv.Itoa(len(b)) + "\x00"))
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

// revisionOf is SHA-256 over the sorted `file\0version` listing.
func revisionOf(files []storageFile) string {
	listing := make([]string, len(files))
	for i, f := range files {
		listing[i] = f.File + "\x00" + f.Version
	}
	sort.SliceStable(listing, func(i, j int) bool { return compareJS(listing[i], listing[j]) < 0 })
	sum := sha256.Sum256([]byte(strings.Join(listing, "\n")))
	return hex.EncodeToString(sum[:])
}

func toPosixRel(base, target string) string {
	rel, err := filepath.Rel(base, target)
	if err != nil || rel == "." {
		return "."
	}
	return filepath.ToSlash(rel)
}

type storageDescription struct {
	Root           string
	AssetsDir      string
	AssetsMaxBytes int64
}

func (s *FSStore) describe() storageDescription {
	return storageDescription{
		Root:           toPosixRel(s.repoRoot, s.root),
		AssetsDir:      toPosixRel(s.repoRoot, s.assetsDir),
		AssetsMaxBytes: s.assetsMaxBytes,
	}
}

func assertBlockFile(file string) error {
	if !IsBlockFileName(file) {
		return &storageInvalidFile{file: file}
	}
	return nil
}

func wrapIOError(err error) error {
	var nf *storageNotFound
	var un *storageUnavailable
	var inv *storageInvalidFile
	if errors.As(err, &nf) || errors.As(err, &un) || errors.As(err, &inv) {
		return err
	}
	// OPEN: the message text is Go's, not Node's (`filesystem error: ENOENT: …`).
	return &storageUnavailable{msg: "filesystem error: " + err.Error(), retryAfterMs: -1}
}

func (s *FSStore) hashFile(file string) (*storageFile, error) {
	path := filepath.Join(s.blocksDir, file)
	info, err := os.Stat(path)
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil
	}
	fingerprint := statFingerprint(info)
	s.hashMu.Lock()
	cached, ok := s.hashCache[file]
	s.hashMu.Unlock()
	if ok && cached.fingerprint == fingerprint {
		return &storageFile{File: file, Version: cached.version, Size: info.Size()}, nil
	}
	b, err := os.ReadFile(path)
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		return nil, err
	}
	version := gitBlobHash(b)
	s.hashMu.Lock()
	s.hashCache[file] = fingerprinted{fingerprint: fingerprint, version: version}
	s.hashMu.Unlock()
	return &storageFile{File: file, Version: version, Size: int64(len(b))}, nil
}

func (s *FSStore) freshVersion(file string) (*string, error) {
	b, err := os.ReadFile(filepath.Join(s.blocksDir, file))
	if err != nil {
		if isMissing(err) {
			return nil, nil
		}
		return nil, err
	}
	v := gitBlobHash(b)
	return &v, nil
}

func (s *FSStore) readSchema() (*storedSchema, error) {
	for _, name := range []string{"schema.gen.json", "meta.gen.json"} {
		b, err := readBytesOrNil(filepath.Join(s.decoDir, name))
		if err != nil {
			return nil, err
		}
		if b != nil {
			text, _ := decodeUTF8(b, false, true)
			return &storedSchema{Version: gitBlobHash(b), Text: text}, nil
		}
	}
	return nil, nil
}

func (s *FSStore) readSecretsPublicKey() (*string, error) {
	b, err := readBytesOrNil(filepath.Join(s.decoDir, "secrets.pub"))
	if err != nil || b == nil {
		return nil, err
	}
	// readFile(path, "utf8") keeps a BOM.
	text, _ := decodeUTF8(b, false, false)
	return &text, nil
}

func (s *FSStore) snapshotRaw() (storageSnapshot, error) {
	ok, err := exists(s.decoDir)
	if err != nil {
		return storageSnapshot{}, err
	}
	if !ok {
		return storageSnapshot{}, &storageNotFound{msg: "no .deco folder in " + s.root}
	}
	var names []string
	entries, err := os.ReadDir(s.blocksDir)
	if err != nil && !isMissing(err) {
		return storageSnapshot{}, err
	}
	for _, e := range entries {
		// Node would see a name that isn't UTF-8 with U+FFFD in it, and then
		// fail to stat it: skipping it is the same outcome.
		if e.Type().IsRegular() && IsBlockFileName(e.Name()) && strings.ToValidUTF8(e.Name(), "�") == e.Name() {
			names = append(names, e.Name())
		}
	}
	files := make([]storageFile, 0, len(names))
	for _, name := range names {
		f, err := s.hashFile(name)
		if err != nil {
			return storageSnapshot{}, err
		}
		if f != nil {
			files = append(files, *f)
		}
	}
	sort.SliceStable(files, func(i, j int) bool { return compareJS(files[i].File, files[j].File) < 0 })
	present := map[string]bool{}
	for _, n := range names {
		present[n] = true
	}
	s.hashMu.Lock()
	for k := range s.hashCache {
		if !present[k] {
			delete(s.hashCache, k)
		}
	}
	s.hashMu.Unlock()
	return storageSnapshot{Revision: revisionOf(files), Files: files}, nil
}

func (s *FSStore) snapshot() (storageSnapshot, error) {
	snap, err := s.snapshotRaw()
	if err != nil {
		return snap, wrapIOError(err)
	}
	return snap, nil
}

// readFiles reads current bodies with the version of the bytes read; a file
// that vanished is left out.
func (s *FSStore) readFiles(files []string) (map[string]storedBody, error) {
	out := map[string]storedBody{}
	for _, file := range files {
		if err := assertBlockFile(file); err != nil {
			return nil, err
		}
		b, err := readBytesOrNil(filepath.Join(s.blocksDir, file))
		if err != nil {
			return nil, err
		}
		if b != nil {
			text, _ := decodeUTF8(b, false, true)
			out[file] = storedBody{Text: text, Version: gitBlobHash(b)}
		}
	}
	return out, nil
}

func (s *FSStore) commit(attempt commitAttempt) (commitResult, error) {
	for _, p := range attempt.Put {
		if err := assertBlockFile(p.File); err != nil {
			return commitResult{}, err
		}
	}
	for _, f := range attempt.Delete {
		if err := assertBlockFile(f); err != nil {
			return commitResult{}, err
		}
	}
	for f := range attempt.Expected {
		if err := assertBlockFile(f); err != nil {
			return commitResult{}, err
		}
	}
	ok, err := exists(s.decoDir)
	if err != nil {
		return commitResult{}, wrapIOError(err)
	}
	if !ok {
		return commitResult{}, &storageNotFound{msg: "no .deco folder in " + s.root}
	}
	result, err := s.withCommitLock(func() (commitResult, error) {
		if !s.swept {
			if err := sweepStaleTransactions(s.decoDir); err != nil {
				return commitResult{}, err
			}
			s.swept = true
		}
		if attempt.CheckSchema {
			schema, err := s.readSchema()
			if err != nil {
				return commitResult{}, err
			}
			var current *string
			if schema != nil {
				current = &schema.Version
			}
			if !sameVersion(current, attempt.ExpectedSchemaVersion) {
				return commitResult{Stale: true}, nil
			}
		}
		for file, expected := range attempt.Expected {
			fresh, err := s.freshVersion(file)
			if err != nil {
				return commitResult{}, err
			}
			if !sameVersion(fresh, expected) {
				return commitResult{Stale: true}, nil
			}
		}
		if err := applyFileChange(s.blocksDir, s.decoDir, attempt.Put, attempt.Delete); err != nil {
			return commitResult{}, err
		}
		versions := map[string]string{}
		for _, p := range attempt.Put {
			versions[p.File] = gitBlobHash([]byte(p.Content))
		}
		after, err := s.snapshotRaw()
		if err != nil {
			return commitResult{}, err
		}
		return commitResult{Revision: after.Revision, Versions: versions}, nil
	})
	if err != nil {
		return commitResult{}, wrapIOError(err)
	}
	return result, nil
}

func sameVersion(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// errTreeBusy: the working tree stayed locked (a publish, rebase or
// autosave) for longer than the daemon waits.
var errTreeBusy = &storageUnavailable{msg: "the working tree is busy", retryAfterMs: 500}

// holdExclusive takes the Exclusive lock, if any.
func (s *FSStore) holdExclusive() (func(), error) {
	if s.exclusive == nil {
		return func() {}, nil
	}
	release, ok := s.exclusive()
	if !ok {
		return nil, errTreeBusy
	}
	return release, nil
}

func (s *FSStore) withCommitLock(fn func() (commitResult, error)) (commitResult, error) {
	releaseTree, err := s.holdExclusive()
	if err != nil {
		return commitResult{}, err
	}
	defer releaseTree()
	s.commitMu.Lock()
	defer s.commitMu.Unlock()
	release, err := acquireFileLock(s.decoDir, s.lockTimeout, s.lockStale)
	if err != nil {
		return commitResult{}, err
	}
	defer release()
	return fn()
}

func acquireFileLock(decoDir string, timeout, stale time.Duration) (func(), error) {
	path := filepath.Join(decoDir, lockFileName)
	deadline := time.Now().Add(timeout)
	for {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, werr := f.WriteString(strconv.Itoa(os.Getpid()) + "\n")
			cerr := f.Close()
			if werr != nil || cerr != nil {
				os.Remove(path)
				return nil, errors.Join(werr, cerr)
			}
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > stale {
			// A crashed writer left its lock behind.
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, &storageUnavailable{msg: "another process is writing .deco/blocks", retryAfterMs: 500}
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- transaction

func writeDurably(path, content string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.WriteString(content); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// syncDir flushes a folder's entries; a no-op where that's unsupported.
func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		if ignorableSyncError(err) {
			return nil
		}
		return err
	}
	defer f.Close()
	if err := f.Sync(); err != nil && !ignorableSyncError(err) {
		return err
	}
	return nil
}

func ignorableSyncError(err error) bool {
	for _, e := range []error{syscall.EISDIR, syscall.EPERM, syscall.EACCES, syscall.EINVAL, syscall.EBADF, syscall.ENOTSUP} {
		if errors.Is(err, e) {
			return true
		}
	}
	return false
}

func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, b, info.Mode().Perm())
}

// preserve hard-links source to backup (a copy where links aren't supported);
// false when there's nothing to preserve.
func preserve(source, backup string) (bool, error) {
	err := os.Link(source, backup)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.ENOTSUP) || errors.Is(err, syscall.EXDEV) || errors.Is(err, syscall.EOPNOTSUPP) {
		if cerr := copyFile(source, backup); cerr != nil {
			if errors.Is(cerr, fs.ErrNotExist) {
				return false, nil
			}
			return false, cerr
		}
		return true, nil
	}
	return false, err
}

func sameFile(a, b string) (bool, error) {
	x, err := os.Stat(a)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	y, err := os.Stat(b)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return os.SameFile(x, y), nil
}

// effectiveDeletes drops a delete that, on a case-insensitive filesystem, is
// the very file a put renames over.
func effectiveDeletes(dir string, put []filePut, deletes []string) ([]string, error) {
	var out []string
	seen := map[string]bool{}
	putSet := map[string]bool{}
	for _, p := range put {
		putSet[p.File] = true
	}
	for _, file := range deletes {
		if seen[file] {
			continue
		}
		seen[file] = true
		if putSet[file] {
			continue
		}
		twin := ""
		for _, p := range put {
			if jsLower(p.File) == jsLower(file) {
				twin = p.File
				break
			}
		}
		if twin != "" {
			same, err := sameFile(filepath.Join(dir, file), filepath.Join(dir, twin))
			if err != nil {
				return nil, err
			}
			if same {
				continue
			}
		}
		out = append(out, file)
	}
	return out, nil
}

// applyFileChange applies puts and deletes to dir atomically: every file
// lands, or dir is left as it was. scratch holds the transaction folder and
// must be on dir's filesystem.
func applyFileChange(dir, scratch string, put []filePut, deletes []string) (err error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	deletes, err = effectiveDeletes(dir, put, deletes)
	if err != nil {
		return err
	}
	tx, err := os.MkdirTemp(scratch, transactionPrefix)
	if err != nil {
		return err
	}
	defer os.RemoveAll(tx)
	staged := filepath.Join(tx, "new")
	backups := filepath.Join(tx, "old")
	if err := os.Mkdir(staged, 0o755); err != nil {
		return err
	}
	if err := os.Mkdir(backups, 0o755); err != nil {
		return err
	}

	type touch struct {
		file   string
		backup string // "" when there was nothing to preserve
	}
	var touched []touch
	isTouched := map[string]bool{}
	defer func() {
		if err == nil {
			return
		}
		for _, t := range touched {
			target := filepath.Join(dir, t.file)
			if t.backup != "" {
				os.Rename(t.backup, target)
			} else {
				os.Remove(target)
			}
		}
	}()

	for i, p := range put {
		if err = writeDurably(filepath.Join(staged, strconv.Itoa(i)), p.Content); err != nil {
			return err
		}
	}
	targets := make([]string, 0, len(put)+len(deletes))
	for _, p := range put {
		targets = append(targets, p.File)
	}
	targets = append(targets, deletes...)
	for _, file := range targets {
		if isTouched[file] {
			continue
		}
		backup := filepath.Join(backups, strconv.Itoa(len(touched)))
		var kept bool
		if kept, err = preserve(filepath.Join(dir, file), backup); err != nil {
			return err
		}
		if !kept {
			backup = ""
		}
		isTouched[file] = true
		touched = append(touched, touch{file: file, backup: backup})
	}
	for i, p := range put {
		if err = os.Rename(filepath.Join(staged, strconv.Itoa(i)), filepath.Join(dir, p.File)); err != nil {
			return err
		}
	}
	for _, file := range deletes {
		if rmErr := os.Remove(filepath.Join(dir, file)); rmErr != nil && !errors.Is(rmErr, fs.ErrNotExist) {
			err = rmErr
			return err
		}
	}
	err = syncDir(dir)
	return err
}

// sweepStaleTransactions removes the transaction folders a crashed commit
// left; call it only under the commit lock.
func sweepStaleTransactions(scratch string) error {
	entries, err := os.ReadDir(scratch)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), transactionPrefix) {
			os.RemoveAll(filepath.Join(scratch, e.Name()))
		}
	}
	return nil
}

// ---------------------------------------------------------------- assets

// suffixedAssetName is the name to try when name is taken: a short random
// suffix before the extension.
func suffixedAssetName(name string) string {
	var b [3]byte
	rand.Read(b[:])
	suffix := hex.EncodeToString(b[:])
	if dot := strings.LastIndex(name, "."); dot > 0 {
		return name[:dot] + "-" + suffix + name[dot:]
	}
	return name + "-" + suffix
}

// putAsset stores an upload, never overwriting a file; it returns the stored name.
func (s *FSStore) putAsset(name string, body []byte) (string, error) {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.HasPrefix(name, ".") {
		return "", errors.New("not an asset file name: " + name)
	}
	if err := s.checkContained(); err != nil {
		return "", err
	}
	releaseTree, err := s.holdExclusive()
	if err != nil {
		return "", err
	}
	defer releaseTree()
	if err := os.MkdirAll(s.assetsDir, 0o755); err != nil {
		return "", err
	}
	candidate := name
	for attempt := 0; ; attempt++ {
		path := filepath.Join(s.assetsDir, candidate)
		if filepath.Dir(path) != s.assetsDir {
			return "", errors.New("invalid asset path")
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err != nil {
			if !errors.Is(err, fs.ErrExist) || attempt > 20 {
				return "", err
			}
			candidate = suffixedAssetName(name)
			continue
		}
		_, werr := f.Write(body)
		serr := f.Sync()
		cerr := f.Close()
		if err := errors.Join(werr, serr, cerr); err != nil {
			return "", err
		}
		return candidate, nil
	}
}
