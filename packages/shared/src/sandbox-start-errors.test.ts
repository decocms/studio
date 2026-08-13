import { expect, test } from "bun:test";
import {
  decodeSandboxStartError,
  encodeSandboxStartError,
  SANDBOX_START_ERROR_CODES,
} from "./sandbox-start-errors";

const CODE = SANDBOX_START_ERROR_CODES.githubNotAuthenticated;

test("round-trips a coded message", () => {
  const encoded = encodeSandboxStartError(CODE, "No GitHub token found.");
  expect(decodeSandboxStartError(encoded)).toEqual({
    code: CODE,
    message: "No GitHub token found.",
  });
});

test("preserves ':: ' inside the message", () => {
  const encoded = encodeSandboxStartError(CODE, "a::b::c");
  expect(decodeSandboxStartError(encoded)).toEqual({
    code: CODE,
    message: "a::b::c",
  });
});

test("round-trips the missing-connection code distinctly", () => {
  const encoded = encodeSandboxStartError(
    SANDBOX_START_ERROR_CODES.githubConnectionMissing,
    "GitHub connection conn_x no longer exists.",
  );
  expect(decodeSandboxStartError(encoded)).toEqual({
    code: SANDBOX_START_ERROR_CODES.githubConnectionMissing,
    message: "GitHub connection conn_x no longer exists.",
  });
});

test("plain (uncoded) text → code null, full text as message", () => {
  expect(decodeSandboxStartError("some raw failure")).toEqual({
    code: null,
    message: "some raw failure",
  });
});

test("unknown prefix is not treated as a code", () => {
  expect(decodeSandboxStartError("NOT_A_CODE::hi")).toEqual({
    code: null,
    message: "NOT_A_CODE::hi",
  });
});
