/**
 * Writes one line of command output to stdout. Bun's `console.log` drops
 * output past the pipe buffer when the reader is slow (`decocms … | jq`);
 * `process.stdout.write` does not.
 */
export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
