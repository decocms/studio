package setup

import (
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
)

// SpawnStep runs `sh -c cmd` streaming merged stdout+stderr to onChunk and
// returning the exit code. Extra env is merged over the daemon's env.
// Corepack strict-off and download-prompt-off are forced in the child env
// (no process-global to patch in Go).
func SpawnStep(cmd string, onChunk func(data string), extraEnv map[string]string) int {
	c := exec.Command("sh", "-c", cmd)
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	env["COREPACK_ENABLE_STRICT"] = "0"
	env["COREPACK_ENABLE_DOWNLOAD_PROMPT"] = "0"
	for k, v := range extraEnv {
		env[k] = v
	}
	flat := make([]string, 0, len(env))
	for k, v := range env {
		flat = append(flat, k+"="+v)
	}
	c.Env = flat
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout, _ := c.StdoutPipe()
	stderr, _ := c.StderrPipe()
	if err := c.Start(); err != nil {
		onChunk("spawn error: " + err.Error() + "\r\n")
		return -1
	}
	var wg sync.WaitGroup
	read := func(r interface{ Read([]byte) (int, error) }) {
		defer wg.Done()
		buf := make([]byte, 8192)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				onChunk(string(buf[:n]))
			}
			if err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go read(stdout)
	go read(stderr)
	wg.Wait()
	err := c.Wait()
	if err == nil {
		return 0
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return exitErr.ExitCode()
	}
	return -1
}
