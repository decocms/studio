import { describe, expect, test } from "bun:test";
import { shouldNotifyWebSessionRefetch } from "@/desktop/native-session-sync";

const SIGNED_IN = { signedIn: true };

describe("shouldNotifyWebSessionRefetch", () => {
  test("notifies when native is signed in, web has no session, and the status is a fresh signal", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: SIGNED_IN,
        lastNotifiedStatus: null,
        hasWebSession: false,
        isWebSessionFetchInFlight: false,
      }),
    ).toBe(true);
  });

  test("does not notify while native reports signed out", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: { signedIn: false },
        lastNotifiedStatus: null,
        hasWebSession: false,
        isWebSessionFetchInFlight: false,
      }),
    ).toBe(false);
  });

  test("does not notify before the first auth_status payload arrives", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: undefined,
        lastNotifiedStatus: null,
        hasWebSession: false,
        isWebSessionFetchInFlight: false,
      }),
    ).toBe(false);
  });

  test("does not notify when the web client already holds a session", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: SIGNED_IN,
        lastNotifiedStatus: null,
        hasWebSession: true,
        isWebSessionFetchInFlight: false,
      }),
    ).toBe(false);
  });

  test("does not notify while a /get-session fetch is already in flight", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: SIGNED_IN,
        lastNotifiedStatus: null,
        hasWebSession: false,
        isWebSessionFetchInFlight: true,
      }),
    ).toBe(false);
  });

  test("notifies at most once per status object — same reference is not re-notified even if the session fetch came back empty", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: SIGNED_IN,
        lastNotifiedStatus: SIGNED_IN,
        hasWebSession: false,
        isWebSessionFetchInFlight: false,
      }),
    ).toBe(false);
  });

  test("a NEW status object with the same shape counts as a fresh native signal", () => {
    expect(
      shouldNotifyWebSessionRefetch({
        nativeStatus: { signedIn: true },
        lastNotifiedStatus: SIGNED_IN,
        hasWebSession: false,
        isWebSessionFetchInFlight: false,
      }),
    ).toBe(true);
  });
});
