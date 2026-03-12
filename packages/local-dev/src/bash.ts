import { spawn, type ChildProcess } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const activeChildren = new Set<ChildProcess>();

export function registerBashTool(server: McpServer, rootPath: string): void {
  server.registerTool(
    "bash",
    {
      title: "Bash",
      description:
        "Execute a bash command in the project folder. Unrestricted — can run git, bun, npm, deno, " +
        "arbitrary scripts, and dev servers. Commands run with cwd set to the project root. " +
        "For background processes, use bash & syntax (e.g. 'bun dev &'). " +
        "Use timeout: 0 for commands with no time limit.",
      inputSchema: {
        cmd: z.string().describe("Bash command to execute"),
        timeout: z
          .number()
          .optional()
          .default(120000)
          .describe(
            "Timeout in milliseconds. Default 120s. Use 0 for no timeout.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async ({ cmd, timeout }) => {
      return new Promise((resolve) => {
        const child = spawn("bash", ["-c", cmd], {
          cwd: rootPath,
          stdio: ["ignore", "pipe", "pipe"],
        });

        activeChildren.add(child);

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });

        let timer: ReturnType<typeof setTimeout> | undefined;
        if (timeout && timeout > 0) {
          timer = setTimeout(() => {
            child.kill("SIGTERM");
          }, timeout);
        }

        child.on("exit", (code) => {
          activeChildren.delete(child);
          if (timer) clearTimeout(timer);
          const structured = {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: code ?? -1,
          };
          resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify(structured),
              },
            ],
            structuredContent: structured,
          });
        });

        child.on("error", (err) => {
          activeChildren.delete(child);
          if (timer) clearTimeout(timer);
          const structured = {
            stdout: "",
            stderr: err.message,
            exitCode: -1,
          };
          resolve({
            content: [
              {
                type: "text",
                text: JSON.stringify(structured),
              },
            ],
            structuredContent: structured,
            isError: true,
          });
        });
      });
    },
  );
}
