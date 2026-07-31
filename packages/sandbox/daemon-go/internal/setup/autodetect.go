package setup

import (
	"os"
	"path/filepath"
)

type Detection struct {
	PackageManager string
	Runtime        string
}

var detectRules = []struct {
	File      string
	Detection Detection
}{
	{"deno.json", Detection{"deno", "deno"}},
	{"deno.jsonc", Detection{"deno", "deno"}},
	{"bun.lock", Detection{"bun", "bun"}},
	{"bun.lockb", Detection{"bun", "bun"}},
	{"pnpm-lock.yaml", Detection{"pnpm", "node"}},
	{"yarn.lock", Detection{"yarn", "node"}},
}

var npmFallback = Detection{"npm", "node"}

func Autodetect(repoDir string) Detection {
	for _, rule := range detectRules {
		if _, err := os.Stat(filepath.Join(repoDir, rule.File)); err == nil {
			return rule.Detection
		}
	}
	return npmFallback
}
