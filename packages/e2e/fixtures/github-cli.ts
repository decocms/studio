#!/usr/bin/env bun
// External CLI stand-in. Studio still spawns a real process and calls GitHub over HTTP.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.slice(0, 4).join(" ") !== "auth token --hostname github.com") {
  process.exit(2);
}
const state = JSON.parse(
  await readFile(join(process.env.GH_CONFIG_DIR!, "fixture.json"), "utf8"),
) as {
  active: string;
  accounts: Record<string, string>;
  failure?: "empty" | "exit";
};
if (state.failure === "exit") {
  console.error("synthetic-secret-in-cli-stderr");
  process.exit(1);
}
if (state.failure === "empty") process.exit(0);
const login = args[4] === "--user" ? args[5]! : state.active;
const token =
  process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? state.accounts[login];
if (!token) process.exit(1);
console.log(token);
