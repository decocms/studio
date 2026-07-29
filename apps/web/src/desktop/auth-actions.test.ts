import { describe, expect, test } from "bun:test";
import {
  createDesktopAuthActions,
  needsBrowserOnlyFallback,
  type DesktopAuthActionDeps,
} from "@/desktop/auth-actions";

function fakeDeps(overrides?: Partial<DesktopAuthActionDeps>) {
  const calls: string[] = [];
  const deps: DesktopAuthActionDeps = {
    browserSignIn: async () => {
      calls.push("browserSignIn");
    },
    completeBridgedSignIn: async () => {
      calls.push("completeBridgedSignIn");
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("createDesktopAuthActions", () => {
  test("socialSignIn ignores its provider input and calls browserSignIn", async () => {
    const { deps, calls } = fakeDeps();
    const actions = createDesktopAuthActions(deps);
    const result = await actions.socialSignIn?.({
      provider: "google",
      callbackURL: "/",
    });
    expect(calls).toEqual(["browserSignIn"]);
    expect(result).toEqual({});
  });

  test("ssoSignIn ignores its providerId input and calls browserSignIn", async () => {
    const { deps, calls } = fakeDeps();
    const actions = createDesktopAuthActions(deps);
    const result = await actions.ssoSignIn?.({
      providerId: "okta",
      callbackURL: "/",
    });
    expect(calls).toEqual(["browserSignIn"]);
    expect(result).toEqual({});
  });

  test("socialSignIn propagates a browserSignIn rejection instead of swallowing it", async () => {
    const { deps } = fakeDeps({
      browserSignIn: async () => {
        throw new Error("system browser flow failed");
      },
    });
    const actions = createDesktopAuthActions(deps);
    await expect(
      actions.socialSignIn?.({ provider: "google", callbackURL: "/" }),
    ).rejects.toThrow("system browser flow failed");
  });

  test("onAuthenticated calls completeBridgedSignIn and ignores the redirectTo argument", async () => {
    const { deps, calls } = fakeDeps();
    const actions = createDesktopAuthActions(deps);
    await actions.onAuthenticated?.("/some/redirect/path");
    expect(calls).toEqual(["completeBridgedSignIn"]);
  });

  test("does not override submitEmailPassword/requestPasswordReset/sendOtp/submitOtp", () => {
    const { deps } = fakeDeps();
    const actions = createDesktopAuthActions(deps);
    expect(actions.submitEmailPassword).toBeUndefined();
    expect(actions.requestPasswordReset).toBeUndefined();
    expect(actions.sendOtp).toBeUndefined();
    expect(actions.submitOtp).toBeUndefined();
  });
});

const ALL_DISABLED = {
  emailAndPassword: { enabled: false },
  emailOtp: { enabled: false },
  socialProviders: { enabled: false },
  magicLink: { enabled: false },
  sso: { enabled: false },
};

describe("needsBrowserOnlyFallback", () => {
  test("false when nothing is enabled at all", () => {
    expect(needsBrowserOnlyFallback(ALL_DISABLED)).toBe(false);
  });

  test("true when magic link is the ONLY enabled method", () => {
    expect(
      needsBrowserOnlyFallback({
        ...ALL_DISABLED,
        magicLink: { enabled: true },
      }),
    ).toBe(true);
  });

  test("false when magic link is enabled alongside password", () => {
    expect(
      needsBrowserOnlyFallback({
        ...ALL_DISABLED,
        magicLink: { enabled: true },
        emailAndPassword: { enabled: true },
      }),
    ).toBe(false);
  });

  test("false when magic link is enabled alongside email OTP", () => {
    expect(
      needsBrowserOnlyFallback({
        ...ALL_DISABLED,
        magicLink: { enabled: true },
        emailOtp: { enabled: true },
      }),
    ).toBe(false);
  });

  test("false when magic link is enabled alongside a social provider", () => {
    expect(
      needsBrowserOnlyFallback({
        ...ALL_DISABLED,
        magicLink: { enabled: true },
        socialProviders: { enabled: true },
      }),
    ).toBe(false);
  });

  test("false when sso is forced on, even if magic link is also enabled — RunSSO owns that branch instead", () => {
    expect(
      needsBrowserOnlyFallback({
        ...ALL_DISABLED,
        magicLink: { enabled: true },
        sso: { enabled: true },
      }),
    ).toBe(false);
  });

  test("false when password/OTP/social are all enabled and magic link is off", () => {
    expect(
      needsBrowserOnlyFallback({
        emailAndPassword: { enabled: true },
        emailOtp: { enabled: true },
        socialProviders: { enabled: true },
        magicLink: { enabled: false },
        sso: { enabled: false },
      }),
    ).toBe(false);
  });
});
