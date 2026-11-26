import { expect, test } from "bun:test";
import {
  completeGitCredentials,
  repeatsEarlierGitHost,
} from "./complete-git-credentials";

test("completeGitCredentials keeps finished rows and normalizes their host", () => {
  expect(
    completeGitCredentials([
      { host: " GitHub.com ", secretId: "sec_1" },
      { host: "gitlab.example.com:8443", secretId: "sec_2" },
    ]),
  ).toEqual([
    { host: "github.com", secretId: "sec_1" },
    { host: "gitlab.example.com:8443", secretId: "sec_2" },
  ]);
});

test("completeGitCredentials drops rows still being filled in", () => {
  expect(
    completeGitCredentials([
      { host: "", secretId: "" },
      { host: "github.com", secretId: "" },
      { host: "", secretId: "sec_1" },
      { host: "https://github.com", secretId: "sec_1" },
      { host: "github.com/acme", secretId: "sec_1" },
    ]),
  ).toEqual([]);
});

// The schema rejects a list naming a host twice, which would fail the whole
// autosave; the first row keeps the host and the repeat waits in the form.
test("completeGitCredentials keeps the first row for a repeated host", () => {
  const rows = [
    { host: "github.com", secretId: "sec_1" },
    { host: "GITHUB.COM", secretId: "sec_2" },
    { host: "gitlab.com", secretId: "sec_3" },
  ];
  expect(completeGitCredentials(rows)).toEqual([
    { host: "github.com", secretId: "sec_1" },
    { host: "gitlab.com", secretId: "sec_3" },
  ]);
  expect(rows.map((_, i) => repeatsEarlierGitHost(rows, i))).toEqual([
    false,
    true,
    false,
  ]);
});

test("repeatsEarlierGitHost ignores rows with no host yet", () => {
  const rows = [
    { host: "", secretId: "" },
    { host: " ", secretId: "" },
  ];
  expect(repeatsEarlierGitHost(rows, 1)).toBe(false);
});

// A half-typed first row must not hide a finished row behind it.
test("completeGitCredentials does not count a dropped row as the host's first", () => {
  expect(
    completeGitCredentials([
      { host: "github.com", secretId: "" },
      { host: "github.com", secretId: "sec_2" },
    ]),
  ).toEqual([{ host: "github.com", secretId: "sec_2" }]);
});
