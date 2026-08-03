/**
 * Injectable network + post-auth actions for the shared sign-in surface
 * (`AuthEntry` / `UnifiedAuthForm`). A call site that passes no `actions`
 * override gets platform defaults resolved inside `AuthEntry`: on the web
 * build that is exactly `defaultAuthFormActions` below — BYTE-IDENTICAL to
 * what `UnifiedAuthForm` did before this indirection existed (same
 * `authClient` calls, same `window.location.href` navigate) — while the
 * desktop build additionally layers the browser-hop/Keychain-bridge
 * overrides on top (`@/desktop/use-desktop-auth-form-defaults`), so social/
 * SSO buttons can never silently dead-end inside the Tauri webview again.
 *
 * See `apps/web/src/desktop/auth-actions.ts` for why only three of the six
 * slots need a desktop-specific implementation.
 */
import { authClient } from "@/lib/auth-client";

/** Loose structural result shape every `authClient` call below actually
 *  returns (`{data, error}`) — narrowed to just the `error` field this
 *  module's callers (`UnifiedAuthForm`'s mutations) read. Declared instead
 *  of importing better-auth's generic client types so an injected desktop
 *  implementation doesn't need to fight those generics to satisfy the
 *  interface. */
export interface AuthActionResult {
  error?: { message?: string | null } | null;
}

export interface AuthFormActions {
  /** Email/password sign-in or sign-up (mode carries which). */
  submitEmailPassword: (input: {
    mode: "sign_in" | "sign_up";
    email: string;
    password: string;
    name?: string;
  }) => Promise<AuthActionResult>;
  requestPasswordReset: (input: {
    email: string;
    redirectTo: string;
  }) => Promise<AuthActionResult>;
  /** The two legs of the email-OTP flow. */
  sendOtp: (input: { email: string }) => Promise<AuthActionResult>;
  submitOtp: (input: {
    email: string;
    otp: string;
  }) => Promise<AuthActionResult>;
  socialSignIn: (input: {
    provider: string;
    callbackURL: string;
  }) => Promise<AuthActionResult>;
  ssoSignIn: (input: {
    providerId: string;
    callbackURL: string;
  }) => Promise<AuthActionResult>;
  /**
   * Runs once after a successful password or OTP sign-in (never on a bare
   * sign-up-only or forgot-password success). Web navigates to finish the
   * (possibly OAuth-authorize) redirect chain; desktop instead bridges the
   * Better-Auth cookie session into the Keychain — see
   * `apps/web/src/desktop/auth-actions.ts`.
   */
  onAuthenticated: (redirectTo: string) => void | Promise<void>;
}

export const defaultAuthFormActions: AuthFormActions = {
  submitEmailPassword: ({ mode, email, password, name }) =>
    mode === "sign_up"
      ? authClient.signUp.email({ email, password, name: name || "" })
      : authClient.signIn.email({ email, password }),
  requestPasswordReset: ({ email, redirectTo }) =>
    authClient.requestPasswordReset({ email, redirectTo }),
  sendOtp: ({ email }) =>
    authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" }),
  submitOtp: ({ email, otp }) => authClient.signIn.emailOtp({ email, otp }),
  socialSignIn: ({ provider, callbackURL }) =>
    authClient.signIn.social({ provider, callbackURL }),
  ssoSignIn: ({ providerId, callbackURL }) =>
    authClient.signIn.sso({ providerId, callbackURL }),
  onAuthenticated: (redirectTo) => {
    window.location.href = redirectTo;
  },
};
