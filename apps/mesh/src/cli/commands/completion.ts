/**
 * `deco completion` — install shell completion scripts.
 */
import { writeFile } from "fs/promises";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

function generateBashCompletionScript(): string {
  return `#!/bin/bash

# Deco CMS completion script for bash
_deco_completion() {
  local cur prev words cword
  _init_completion || return

  case $prev in
    -p|--port)
      return 0
      ;;
    --home)
      _filedir -d
      return 0
      ;;
    *)
      COMPREPLY=($(compgen -W "init completion --help --version --port --home --skip-migrations --no-tui --local-mode --no-local-mode" -- "$cur"))
      ;;
  esac
}

complete -F _deco_completion deco
complete -F _deco_completion decocms
`;
}

function generateZshCompletionScript(): string {
  return `#compdef deco decocms

_deco() {
  local context state state_descr line
  typeset -A opt_args

  _arguments -C \\
    '1: :_deco_commands' \\
    '-p[Server port]:port:' \\
    '--port[Server port]:port:' \\
    '--home[Data directory]:directory:_directories' \\
    '--skip-migrations[Skip database migrations]' \\
    '--no-tui[Disable Ink UI]' \\
    '--local-mode[Enable local mode]' \\
    '--no-local-mode[Disable local mode (dev)]' \\
    '-h[Show help]' \\
    '--help[Show help]' \\
    '-v[Show version]' \\
    '--version[Show version]' \\
    '*:: :->args'
}

_deco_commands() {
  local commands
  commands=(
    'init:Scaffold a new MCP app'
    'completion:Install shell completion'
  )
  _describe 'commands' commands
}

_deco "$@"
`;
}

export async function completionCommand(shell?: string): Promise<void> {
  const targetShell = shell || process.env.SHELL?.split("/").pop() || "bash";

  let script: string;
  let installPath: string;

  switch (targetShell) {
    case "bash": {
      script = generateBashCompletionScript();
      installPath = join(
        homedir(),
        ".local/share/bash-completion/completions/deco",
      );
      break;
    }
    case "zsh": {
      script = generateZshCompletionScript();
      installPath = join(homedir(), ".zsh/completions/_deco");
      break;
    }
    default: {
      console.error(`Unsupported shell: ${targetShell}`);
      console.log("Supported shells: bash, zsh");
      process.exit(1);
    }
  }

  mkdirSync(dirname(installPath), { recursive: true });
  await writeFile(installPath, script, "utf8");

  console.log(`Completion script installed to: ${installPath}`);
  console.log("");

  if (targetShell === "bash") {
    console.log("To enable completions, add to your ~/.bashrc:");
    console.log(`  source "${installPath}"`);
  } else {
    console.log("To enable completions, add to your ~/.zshrc:");
    console.log(`  fpath=("${dirname(installPath)}" $fpath)`);
    console.log("  autoload -U compinit && compinit");
  }

  console.log("");
  console.log("Then restart your shell.");
}
