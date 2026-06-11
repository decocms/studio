// Bun's `// @bun` fast-parse path rejects `using` declarations, which the
// daemon graph uses (mcp-utils/sandbox/run-code.ts). Strip the pragma so Bun
// transpiles on load instead. See packages/sandbox build script.
const target = new URL("./dist/daemon.js", import.meta.url);
const source = await Bun.file(target).text();
if (source.startsWith("// @bun")) {
  await Bun.write(target, source.replace(/^\/\/ @bun\n/, ""));
}
