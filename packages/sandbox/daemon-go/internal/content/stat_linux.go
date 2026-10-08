package content

import (
	"os"
	"strconv"
	"syscall"
)

// statFingerprint is `ino:size:mtimeNs:ctimeNs`: an unchanged fingerprint
// means an unchanged file, so a poll only rehashes what changed.
func statFingerprint(info os.FileInfo) string {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return strconv.FormatInt(info.Size(), 10) + ":" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	}
	return strconv.FormatUint(uint64(st.Ino), 10) + ":" + strconv.FormatInt(st.Size, 10) + ":" +
		strconv.FormatInt(st.Mtim.Nano(), 10) + ":" + strconv.FormatInt(st.Ctim.Nano(), 10)
}
