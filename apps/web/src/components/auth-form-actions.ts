/**
 * Injectable network + post-auth actions for the shared sign-in surface
 * (`AuthEntry` / `UnifiedAuthForm`). A call site that passes no `actions`
 * override gets `defaultAuthFormActions` below; embedded surfaces override
 * `onAuthenticated` to unlock their own content instead of navigating.
 */
import { authClient } from "@/lib/auth-client";

/** Loose structural result shape every `authClient` call below actually
 *  returns (`{data, error}`) — narrowed to just the `error` field this
 *  module's callers (`UnifiedAuthForm`'s mutations) read. */
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
   * sign-up-only or forgot-password success). The default navigates to
   * finish the (possibly OAuth-authorize) redirect chain.
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
