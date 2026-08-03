package setup

import (
	"fmt"

	"github.com/decocms/studio/sandbox-daemon/internal/config"
)

type PmConfig struct {
	Install   string
	RunPrefix string
	Manifests []string
}

var PackageManagers = map[string]PmConfig{
	"npm":  {Install: "npm install", RunPrefix: "npm run", Manifests: []string{"package.json"}},
	"pnpm": {Install: "pnpm install", RunPrefix: "pnpm run", Manifests: []string{"package.json"}},
	"yarn": {Install: "yarn install", RunPrefix: "yarn run", Manifests: []string{"package.json"}},
	"bun":  {Install: "bun install", RunPrefix: "bun run", Manifests: []string{"package.json"}},
	"deno": {RunPrefix: "deno task", Manifests: []string{"deno.json", "deno.jsonc", "package.json"}},
}

func BuildDevEnv(cfg *config.Enriched, overrides map[string]string) map[string]string {
	env := map[string]string{"HOST": "0.0.0.0", "HOSTNAME": "0.0.0.0"}
	for k, v := range overrides {
		env[k] = v
	}
	if cfg != nil {
		if port, ok := cfg.Port(); ok {
			if _, has := env["PORT"]; !has {
				env["PORT"] = fmt.Sprintf("%d", port)
			}
		}
	}
	return env
}

type RunCommand struct {
	Cmd   string
	Label string
}

func PmRunCommand(runtimePrefix, cwd, runPrefix, script string) RunCommand {
	cmd := fmt.Sprintf("%scd %s && %s %s", runtimePrefix, cwd, runPrefix, script)
	return RunCommand{Cmd: cmd, Label: "$ " + cmd}
}
