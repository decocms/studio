/**
 * MCP Local Dev - Logger
 *
 * Nice formatted logging that goes to stderr (to not interfere with stdio protocol)
 * but uses colors/formatting that indicate it's informational, not an error.
 */

// ANSI color codes
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",

  // Foreground colors
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
  white: "\x1b[37m",
};

// Operation type colors
const opColors: Record<string, string> = {
  READ: colors.cyan,
  WRITE: colors.green,
  DELETE: colors.yellow,
  MOVE: colors.magenta,
  COPY: colors.blue,
  MKDIR: colors.blue,
  LIST: colors.gray,
  STAT: colors.gray,
  EDIT: colors.green,
  SEARCH: colors.cyan,
};

function timestamp(): string {
  const now = new Date();
  return `${colors.dim}${now.toLocaleTimeString("en-US", { hour12: false })}${colors.reset}`;
}

function formatPath(path: string): string {
  return `${colors.white}${path}${colors.reset}`;
}

function formatOp(op: string): string {
  const color = opColors[op] || colors.white;
  return `${color}${colors.bold}${op.padEnd(6)}${colors.reset}`;
}

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${colors.dim}(${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]})${colors.reset}`;
}

const prefix = `${colors.cyan}◆${colors.reset}`;

/**
 * Log a file operation
 */
export function logOp(
  op: string,
  path: string,
  extra?: {
    size?: number;
    to?: string;
    count?: number;
    recursive?: boolean;
    error?: string;
  },
): void {
  let msg = `${prefix} ${timestamp()} ${formatOp(op)} ${formatPath(path)}`;

  if (extra?.to) {
    msg += ` ${colors.dim}→${colors.reset} ${formatPath(extra.to)}`;
  }

  if (extra?.size !== undefined) {
    msg += ` ${formatSize(extra.size)}`;
  }

  if (extra?.count !== undefined) {
    const recursiveLabel = extra.recursive ? " recursive" : "";
    msg += ` ${colors.dim}(${extra.count}${recursiveLabel} items)${colors.reset}`;
  }

  if (extra?.error) {
    msg += ` ${colors.yellow}[${extra.error}]${colors.reset}`;
  }

  console.error(msg);
}

/**
 * Log server startup
 */
export function logStart(rootPath: string): void {
  console.error(
    `\n${prefix} ${colors.cyan}${colors.bold}mcp-local-dev${colors.reset} ${colors.dim}started${colors.reset}`,
  );
  console.error(
    `${prefix} ${colors.dim}root:${colors.reset} ${colors.white}${rootPath}${colors.reset}\n`,
  );
}

/**
 * Log an error (still uses red, but with the prefix)
 */
export function logError(op: string, path: string, error: Error): void {
  console.error(
    `${prefix} ${timestamp()} ${colors.yellow}${colors.bold}ERR${colors.reset} ${formatOp(op)} ${formatPath(path)} ${colors.dim}${error.message}${colors.reset}`,
  );
}

/**
 * Log a tool call
 */
export function logTool(
  toolName: string,
  args: Record<string, unknown>,
  result?: { isError?: boolean },
): void {
  const argsStr = formatArgs(args);
  const status = result?.isError
    ? `${colors.yellow}✗${colors.reset}`
    : `${colors.green}✓${colors.reset}`;

  if (result) {
    console.error(
      `${prefix} ${timestamp()} ${colors.magenta}${colors.bold}TOOL${colors.reset}  ${colors.white}${toolName}${colors.reset}${argsStr} ${status}`,
    );
  } else {
    console.error(
      `${prefix} ${timestamp()} ${colors.magenta}${colors.bold}TOOL${colors.reset}  ${colors.white}${toolName}${colors.reset}${argsStr}`,
    );
  }
}

function formatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";

  const parts = entries.map(([key, value]) => {
    let valStr: string;
    if (typeof value === "string") {
      // Truncate long strings
      valStr = value.length > 50 ? `"${value.slice(0, 47)}..."` : `"${value}"`;
    } else if (Array.isArray(value)) {
      valStr = `[${value.length} items]`;
    } else if (typeof value === "object" && value !== null) {
      valStr = "{...}";
    } else {
      valStr = String(value);
    }
    return `${colors.dim}${key}=${colors.reset}${valStr}`;
  });

  return ` ${parts.join(" ")}`;
}
