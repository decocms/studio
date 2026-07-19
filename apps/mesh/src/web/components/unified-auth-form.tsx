import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { authClient } from "@/web/lib/auth-client";
import { track } from "@/web/lib/posthog-client";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

export type AuthFlowMethod =
  | "email_otp"
  | "email_password"
  | "social"
  | "sso"
  | "local";

export type AuthFlowEvent =
  | {
      type: "started" | "succeeded";
      method: AuthFlowMethod;
      provider?: string;
      mode?: "sign_in" | "sign_up";
    }
  | { type: "otp_sent" | "otp_submitted"; method: "email_otp" }
  | {
      type: "failed";
      method: AuthFlowMethod;
      stage:
        | "validation"
        | "authenticate"
        | "send_otp"
        | "verify_otp"
        | "redirect";
      error: string;
      provider?: string;
      mode?: "sign_in" | "sign_up";
    };

interface UnifiedAuthFormProps {
  /**
   * URL to redirect to after successful authentication.
   * Used for OAuth flows to redirect back to the authorize endpoint.
   * Takes priority over callbackUrl when set.
   */
  redirectUrl?: string | null;
  /**
   * General post-login redirect (e.g. the `next` query param).
   * Used when redirectUrl is not set. Defaults to "/".
   */
  callbackUrl?: string;
  /**
   * Title for the default sign-in/sign-up view. Contextual views
   * (forgot password, OTP sent) keep their own titles.
   * Defaults to "Welcome to deco".
   */
  title?: string;
  /**
   * Subtitle for the default sign-in/sign-up view. `undefined` keeps the
   * default text; `null` hides the subtitle entirely.
   * Defaults to "Sign in or create a new account".
   */
  subtitle?: string | null;
  /**
   * Brand element rendered above the header. Defaults to the deco logo.
   */
  brand?: React.ReactNode;
  /** Optional localized copy for this auth surface. */
  copy?: Partial<UnifiedAuthFormCopy>;
  /** Compact layout for embedded auth surfaces. The login page stays default. */
  variant?: "default" | "compact";
  /** Limit social buttons without changing the deployment-wide auth config. */
  allowedSocialProviders?: string[];
  /** Hide password auth when an embedded surface should use OTP only. */
  allowPassword?: boolean;
  /** Optional lifecycle sink for embedded surfaces with their own funnel. */
  onAuthEvent?: (event: AuthFlowEvent) => void;
}

type FormView = "signIn" | "signUp" | "forgotPassword" | "emailOtp";

const VIEW_TOGGLE_LINK_CLASS =
  "font-medium text-[#8CAA25] hover:underline disabled:opacity-50";

export interface UnifiedAuthFormCopy {
  signUpFailed: string;
  signInFailed: string;
  authenticationFailed: string;
  resetEmailFailed: string;
  otpSendFailed: string;
  invalidCode: string;
  invalidEmail: string;
  invalidEmailOrPassword: string;
  accountExists: string;
  networkError: string;
  tooManyAttempts: string;
  invalidOrExpiredCode: string;
  genericError: string;
  resetPasswordTitle: string;
  verificationCodeTitle: string;
  welcomeTitle: string;
  resetPasswordSubtitle: string;
  codeSentTo: (email: string) => string;
  defaultSubtitle: string;
  resetEmailSent: string;
  continueWith: (provider: string) => string;
  divider: string;
  emailLabel: string;
  emailPlaceholder: string;
  sending: string;
  sendCode: string;
  verificationCodeLabel: string;
  enterCodePlaceholder: string;
  verifying: string;
  verify: string;
  useDifferentEmail: string;
  sendResetLink: string;
  nameLabel: string;
  namePlaceholder: string;
  passwordLabel: string;
  forgotPassword: string;
  creatingAccount: string;
  signingIn: string;
  continue: string;
  backToSignIn: string;
  signInWithPassword: string;
  alreadyHaveAccount: string;
  dontHaveAccount: string;
  signIn: string;
  signUp: string;
  signInWithEmailCode: string;
}

const DEFAULT_AUTH_FORM_COPY: UnifiedAuthFormCopy = {
  signUpFailed: "Sign up failed",
  signInFailed: "Sign in failed",
  authenticationFailed: "Authentication failed",
  resetEmailFailed: "Failed to send reset email",
  otpSendFailed: "Failed to send code",
  invalidCode: "Invalid code",
  invalidEmail: "Invalid email address",
  invalidEmailOrPassword: "Invalid email or password. Please try again.",
  accountExists:
    "An account with this email already exists. Try signing in instead.",
  networkError: "Network error. Please check your connection and try again.",
  tooManyAttempts: "Too many attempts. Please wait a moment and try again.",
  invalidOrExpiredCode: "Invalid or expired code. Please try again.",
  genericError: "An error occurred. Please try again.",
  resetPasswordTitle: "Reset your password",
  verificationCodeTitle: "Enter verification code",
  welcomeTitle: "Welcome to deco",
  resetPasswordSubtitle: "We'll send you a reset link",
  codeSentTo: (email) => `Code sent to ${email}`,
  defaultSubtitle: "Sign in or create a new account",
  resetEmailSent: "Check your email for a password reset link.",
  continueWith: (provider) => `Continue with ${provider}`,
  divider: "or",
  emailLabel: "Email",
  emailPlaceholder: "Email address",
  sending: "Sending...",
  sendCode: "Send code",
  verificationCodeLabel: "Verification code",
  enterCodePlaceholder: "Enter code",
  verifying: "Verifying...",
  verify: "Verify",
  useDifferentEmail: "Use a different email",
  sendResetLink: "Send reset link",
  nameLabel: "Name",
  namePlaceholder: "Your name",
  passwordLabel: "Password",
  forgotPassword: "Forgot password?",
  creatingAccount: "Creating account...",
  signingIn: "Signing in...",
  continue: "Continue",
  backToSignIn: "Back to sign in",
  signInWithPassword: "Sign in with password instead",
  alreadyHaveAccount: "Already have an account? ",
  dontHaveAccount: "Don't have an account? ",
  signIn: "Sign in",
  signUp: "Sign up",
  signInWithEmailCode: "Sign in with email code",
};

export function UnifiedAuthForm({
  redirectUrl,
  callbackUrl = "/",
  title,
  subtitle,
  brand,
  copy: copyOverrides,
  variant = "default",
  allowedSocialProviders,
  allowPassword = true,
  onAuthEvent,
}: UnifiedAuthFormProps) {
  const { emailAndPassword, resetPassword, emailOtp, socialProviders } =
    useAuthConfig();
  const emitAuthEvent = (event: AuthFlowEvent) => {
    try {
      onAuthEvent?.(event);
    } catch {
      // An analytics sink must never interrupt authentication.
    }
  };
  const compact = variant === "compact";
  const restrictedSocialProviders = allowedSocialProviders
    ? socialProviders.providers.filter((provider) =>
        allowedSocialProviders.includes(provider.name),
      )
    : socialProviders.providers;
  const hasRestrictedSocialProviders =
    socialProviders.enabled && restrictedSocialProviders.length > 0;
  const passwordAvailableWithoutSocialFallback =
    emailAndPassword.enabled &&
    (allowPassword || (!emailOtp.enabled && !hasRestrictedSocialProviders));
  // An embedded allowlist must not dead-end a deployment whose only enabled
  // method is another social provider (for example a GitHub-only self-host).
  const visibleSocialProviders =
    socialProviders.enabled &&
    socialProviders.providers.length > 0 &&
    !hasRestrictedSocialProviders &&
    !emailOtp.enabled &&
    !passwordAvailableWithoutSocialFallback
      ? socialProviders.providers
      : restrictedSocialProviders;
  const hasSocialProviders =
    socialProviders.enabled && visibleSocialProviders.length > 0;
  const emailAndPasswordEnabled =
    emailAndPassword.enabled &&
    (allowPassword || (!emailOtp.enabled && !hasSocialProviders));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [view, setView] = useState<FormView>(() => {
    if (emailOtp.enabled) {
      return "emailOtp";
    }
    const hasLoggedIn = globalThis.localStorage?.getItem("hasLoggedIn");
    return hasLoggedIn !== "true" ? "signUp" : "signIn";
  });
  const [emailError, setEmailError] = useState("");
  const [resetEmailSent, setResetEmailSent] = useState(false);
  const copy = { ...DEFAULT_AUTH_FORM_COPY, ...copyOverrides };

  const isSignUp = view === "signUp";
  const isForgotPassword = view === "forgotPassword";
  const isEmailOtp = view === "emailOtp";

  const emailPasswordMutation = useMutation({
    mutationFn: async ({
      email,
      password,
      name,
    }: {
      email: string;
      password: string;
      name?: string;
    }) => {
      try {
        if (isSignUp) {
          const result = await authClient.signUp.email({
            email,
            password,
            name: name || "",
          });
          if (result.error) {
            throw new Error(result.error.message || copy.signUpFailed);
          }
          return result;
        } else {
          const result = await authClient.signIn.email({ email, password });
          if (result.error) {
            throw new Error(result.error.message || copy.signInFailed);
          }
          return result;
        }
      } catch (err) {
        throw err instanceof Error ? err : new Error(copy.authenticationFailed);
      }
    },
    onMutate: () => {
      emitAuthEvent({
        type: "started",
        method: "email_password",
        mode: isSignUp ? "sign_up" : "sign_in",
      });
    },
    onSuccess: () => {
      emitAuthEvent({
        type: "succeeded",
        method: "email_password",
        mode: isSignUp ? "sign_up" : "sign_in",
      });
      globalThis.localStorage?.setItem("hasLoggedIn", "true");
      window.location.href = redirectUrl ?? callbackUrl;
    },
    onError: (error) => {
      emitAuthEvent({
        type: "failed",
        method: "email_password",
        mode: isSignUp ? "sign_up" : "sign_in",
        stage: "authenticate",
        error: error instanceof Error ? error.message : String(error),
      });
      track(isSignUp ? "user_signup_failed" : "user_signin_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const forgotPasswordMutation = useMutation({
    mutationFn: async ({ email }: { email: string }) => {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      if (result.error) {
        throw new Error(result.error.message || copy.resetEmailFailed);
      }
      return result;
    },
    onSuccess: () => {
      track("password_reset_requested");
      setResetEmailSent(true);
    },
    onError: (error) => {
      track("password_reset_request_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const sendOtpMutation = useMutation({
    mutationFn: async ({ email }: { email: string }) => {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result.error) {
        throw new Error(result.error.message || copy.otpSendFailed);
      }
      return result;
    },
    onMutate: () => {
      emitAuthEvent({ type: "started", method: "email_otp" });
    },
    onSuccess: () => {
      emitAuthEvent({ type: "otp_sent", method: "email_otp" });
      track("email_otp_sent");
      setOtpSent(true);
    },
    onError: (error) => {
      emitAuthEvent({
        type: "failed",
        method: "email_otp",
        stage: "send_otp",
        error: error instanceof Error ? error.message : String(error),
      });
      track("email_otp_send_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const verifyOtpMutation = useMutation({
    mutationFn: async ({ email, otp }: { email: string; otp: string }) => {
      const result = await authClient.signIn.emailOtp({
        email,
        otp,
      });
      if (result.error) {
        throw new Error(result.error.message || copy.invalidCode);
      }
      return result;
    },
    onMutate: () => {
      emitAuthEvent({ type: "otp_submitted", method: "email_otp" });
    },
    onSuccess: () => {
      emitAuthEvent({ type: "succeeded", method: "email_otp" });
      globalThis.localStorage?.setItem("hasLoggedIn", "true");
      window.location.href = redirectUrl ?? callbackUrl;
    },
    onError: (error) => {
      emitAuthEvent({
        type: "failed",
        method: "email_otp",
        stage: "verify_otp",
        error: error instanceof Error ? error.message : String(error),
      });
      track("email_otp_verify_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleEmailBlur = () => {
    if (email.trim() && !validateEmail(email)) {
      setEmailError(copy.invalidEmail);
    }
  };

  const handleEmailPassword = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError(copy.invalidEmail);
      emitAuthEvent({
        type: "failed",
        method: "email_password",
        mode: isSignUp ? "sign_up" : "sign_in",
        stage: "validation",
        error: "invalid_email",
      });
      return;
    }

    emailPasswordMutation.mutate({ email, password, name });
  };

  const handleForgotPassword = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError(copy.invalidEmail);
      return;
    }

    forgotPasswordMutation.mutate({ email });
  };

  const handleSendOtp = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError(copy.invalidEmail);
      emitAuthEvent({
        type: "failed",
        method: "email_otp",
        stage: "validation",
        error: "invalid_email",
      });
      return;
    }

    sendOtpMutation.mutate({ email });
  };

  const handleVerifyOtp = (e: React.FormEvent) => {
    e.preventDefault();
    verifyOtpMutation.mutate({ email, otp });
  };

  const handleInputChange =
    (setter: (value: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      if (error) {
        emailPasswordMutation.reset();
      }
      if (forgotPasswordError) {
        forgotPasswordMutation.reset();
      }
      if (otpError) {
        sendOtpMutation.reset();
        verifyOtpMutation.reset();
      }
      if (setter === setEmail && emailError) {
        setEmailError("");
      }
    };

  const switchView = (newView: FormView) => {
    setView(newView);
    setName("");
    setOtp("");
    setOtpSent(false);
    setEmailError("");
    setResetEmailSent(false);
    emailPasswordMutation.reset();
    forgotPasswordMutation.reset();
    sendOtpMutation.reset();
    verifyOtpMutation.reset();
  };

  const isLoading =
    emailPasswordMutation.isPending ||
    forgotPasswordMutation.isPending ||
    sendOtpMutation.isPending ||
    verifyOtpMutation.isPending;
  const error = emailPasswordMutation.error;
  const forgotPasswordError = forgotPasswordMutation.error;
  const otpError = sendOtpMutation.error || verifyOtpMutation.error;

  const canSubmit = isSignUp
    ? email.trim() && password.trim() && name.trim()
    : isForgotPassword
      ? email.trim()
      : isEmailOtp
        ? otpSent
          ? otp.trim()
          : email.trim()
        : email.trim() && password.trim();

  const getErrorMessage = (error: Error | null) => {
    if (!error) return null;

    const errorMessage = error.message.toLowerCase();

    if (errorMessage.includes("unauthorized") || errorMessage.includes("401")) {
      return copy.invalidEmailOrPassword;
    }

    if (
      errorMessage.includes("already exists") ||
      errorMessage.includes("409")
    ) {
      return copy.accountExists;
    }

    if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      return copy.networkError;
    }

    if (errorMessage.includes("rate limit") || errorMessage.includes("429")) {
      return copy.tooManyAttempts;
    }

    if (errorMessage.includes("invalid") && errorMessage.includes("otp")) {
      return copy.invalidOrExpiredCode;
    }

    return error.message || copy.genericError;
  };

  const displayError = error || forgotPasswordError || otpError;

  const handleSocialSignIn = async (provider: string) => {
    emitAuthEvent({ type: "started", method: "social", provider });
    try {
      const result = await authClient.signIn.social({
        provider,
        callbackURL: redirectUrl ?? callbackUrl,
      });
      if (result.error) {
        throw new Error(result.error.message || copy.authenticationFailed);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitAuthEvent({
        type: "failed",
        method: "social",
        provider,
        stage: "redirect",
        error: message,
      });
      track("social_signin_failed", { provider, error: message });
    }
  };

  const headerTitle = isForgotPassword
    ? copy.resetPasswordTitle
    : isEmailOtp && otpSent
      ? copy.verificationCodeTitle
      : (title ?? copy.welcomeTitle);

  const headerSubtitle = isForgotPassword
    ? copy.resetPasswordSubtitle
    : isEmailOtp && otpSent
      ? copy.codeSentTo(email)
      : subtitle === undefined
        ? copy.defaultSubtitle
        : subtitle;

  return (
    <div className={cn("grid w-full", compact ? "gap-5" : "gap-10")}>
      {/* Brand */}
      {brand ?? (
        <div>
          <img
            src="/logos/deco logo.svg"
            alt="Deco"
            className="h-12 w-12 dark:hidden"
          />
          <img
            src="/logos/deco logo negative.svg"
            alt="Deco"
            className="h-12 w-12 hidden dark:block"
          />
        </div>
      )}

      {/* Header */}
      <div className="space-y-2">
        <h1
          className={cn(
            "font-medium",
            compact ? "text-xl leading-7" : "text-2xl leading-8",
          )}
        >
          {headerTitle}
        </h1>
        {headerSubtitle && (
          <p
            className={cn(
              "text-muted-foreground",
              compact ? "text-sm leading-5" : "text-base leading-6",
            )}
          >
            {headerSubtitle}
          </p>
        )}
      </div>

      {/* Error message */}
      {displayError && (
        <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
          {getErrorMessage(displayError)}
        </div>
      )}

      {/* Success message for forgot password */}
      {resetEmailSent && (
        <div className="rounded-xl bg-success/10 p-3 text-sm text-success text-center">
          {copy.resetEmailSent}
        </div>
      )}

      {/* Social Provider Buttons */}
      {!isForgotPassword && !(isEmailOtp && otpSent) && hasSocialProviders && (
        <div className="grid gap-2">
          {visibleSocialProviders.map((provider) => (
            <button
              key={provider.name}
              type="button"
              disabled={isLoading}
              onClick={() => void handleSocialSignIn(provider.name)}
              className={cn(
                "flex w-full items-center justify-center gap-3 bg-background px-3 text-sm font-medium text-foreground card-shadow transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
                compact ? "h-11 rounded-lg" : "h-12 rounded-xl",
              )}
            >
              {provider.icon && (
                <img
                  src={provider.icon}
                  alt=""
                  className={cn(
                    "h-5 w-5",
                    provider.name === "github" && "dark:invert",
                  )}
                  aria-hidden="true"
                />
              )}
              {copy.continueWith(
                provider.name.charAt(0).toUpperCase() + provider.name.slice(1),
              )}
            </button>
          ))}
        </div>
      )}

      {/* Divider between social and email-based auth */}
      {!isForgotPassword &&
        !(isEmailOtp && otpSent) &&
        hasSocialProviders &&
        (emailAndPasswordEnabled || emailOtp.enabled) && (
          <div
            className={cn(
              "flex items-center gap-2.5",
              compact ? "my-0" : "-my-4",
            )}
          >
            <div className="h-px flex-1 bg-border" />
            <span
              className={cn(
                "text-muted-foreground",
                compact ? "text-sm" : "text-base",
              )}
            >
              {copy.divider}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )}

      {/* Email OTP Form */}
      {isEmailOtp && emailOtp.enabled && (
        <>
          {!otpSent ? (
            <form
              onSubmit={handleSendOtp}
              className={cn(
                "grid gap-2",
                compact && "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start",
              )}
            >
              <div className="grid gap-2">
                <label
                  className={cn(
                    "text-sm font-medium text-foreground",
                    compact && "sr-only",
                  )}
                >
                  {copy.emailLabel}
                </label>
                <Input
                  type="email"
                  placeholder={copy.emailPlaceholder}
                  value={email}
                  onChange={handleInputChange(setEmail)}
                  onBlur={handleEmailBlur}
                  required
                  disabled={isLoading}
                  aria-invalid={!!emailError}
                  className="h-11 rounded-lg"
                />
                {emailError && (
                  <p className="text-xs text-destructive">{emailError}</p>
                )}
              </div>

              <button
                type="submit"
                disabled={isLoading || !canSubmit}
                className={cn(
                  "flex items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:pointer-events-none disabled:opacity-50",
                  compact ? "h-11 sm:w-auto" : "h-12 w-full",
                )}
              >
                {isLoading ? copy.sending : copy.sendCode}
              </button>
            </form>
          ) : (
            <form
              onSubmit={handleVerifyOtp}
              className={cn(
                "grid gap-2",
                compact && "sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start",
              )}
            >
              <div className="grid gap-2">
                <label
                  className={cn(
                    "text-sm font-medium text-foreground",
                    compact && "sr-only",
                  )}
                >
                  {copy.verificationCodeLabel}
                </label>
                <Input
                  type="text"
                  placeholder={copy.enterCodePlaceholder}
                  value={otp}
                  onChange={handleInputChange(setOtp)}
                  required
                  disabled={isLoading}
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  className="h-11 rounded-lg"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading || !canSubmit}
                className={cn(
                  "flex items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:pointer-events-none disabled:opacity-50",
                  compact ? "h-11 sm:w-auto" : "h-12 w-full",
                )}
              >
                {isLoading ? copy.verifying : copy.verify}
              </button>

              <button
                type="button"
                onClick={() => {
                  setOtpSent(false);
                  setOtp("");
                  sendOtpMutation.reset();
                  verifyOtpMutation.reset();
                }}
                disabled={isLoading}
                className={cn(
                  "mt-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                  compact && "sm:col-span-2",
                )}
              >
                {copy.useDifferentEmail}
              </button>
            </form>
          )}
        </>
      )}

      {/* Forgot Password Form */}
      {isForgotPassword && emailAndPasswordEnabled && !resetEmailSent && (
        <form onSubmit={handleForgotPassword} className="grid gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {copy.emailLabel}
            </label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={handleInputChange(setEmail)}
              onBlur={handleEmailBlur}
              required
              disabled={isLoading}
              aria-invalid={!!emailError}
              className="h-11 rounded-lg"
            />
            {emailError && (
              <p className="text-xs text-destructive mt-1.5">{emailError}</p>
            )}
          </div>

          <Button
            type="submit"
            disabled={isLoading || !canSubmit}
            className="w-full font-semibold"
            size="xl"
          >
            {isLoading ? copy.sending : copy.sendResetLink}
          </Button>
        </form>
      )}

      {/* Email & Password Form */}
      {!isForgotPassword && !isEmailOtp && emailAndPasswordEnabled && (
        <form onSubmit={handleEmailPassword} className="grid gap-5">
          {isSignUp && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {copy.nameLabel}
              </label>
              <Input
                type="text"
                placeholder={copy.namePlaceholder}
                value={name}
                onChange={handleInputChange(setName)}
                required
                disabled={isLoading}
                className="h-11 rounded-lg"
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {copy.emailLabel}
            </label>
            <Input
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={handleInputChange(setEmail)}
              onBlur={handleEmailBlur}
              required
              disabled={isLoading}
              aria-invalid={!!emailError}
              className="h-11 rounded-lg"
            />
            {emailError && (
              <p className="text-xs text-destructive mt-1.5">{emailError}</p>
            )}
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-foreground">
                {copy.passwordLabel}
              </label>
              {!isSignUp && resetPassword.enabled && (
                <button
                  type="button"
                  onClick={() => switchView("forgotPassword")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {copy.forgotPassword}
                </button>
              )}
            </div>
            <Input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={handleInputChange(setPassword)}
              required
              disabled={isLoading}
              className="h-11 rounded-lg"
            />
          </div>

          <div
            className={cn(
              "overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.075,0.82,0.165,1)]",
              canSubmit
                ? "max-h-[100px] opacity-100 translate-y-0"
                : "max-h-0 opacity-0 -translate-y-2",
            )}
          >
            <div className={cn("p-1", !canSubmit && "pointer-events-none")}>
              <Button
                type="submit"
                disabled={isLoading || !canSubmit}
                className={cn("w-full font-semibold")}
                size="xl"
                aria-hidden={!canSubmit}
              >
                {isLoading
                  ? isSignUp
                    ? copy.creatingAccount
                    : copy.signingIn
                  : copy.continue}
              </Button>
            </div>
          </div>
        </form>
      )}

      {/* View toggle links */}
      <div className="text-sm text-muted-foreground">
        {isForgotPassword ? (
          <button
            type="button"
            onClick={() => switchView("signIn")}
            disabled={isLoading}
            className={VIEW_TOGGLE_LINK_CLASS}
          >
            {copy.backToSignIn}
          </button>
        ) : isEmailOtp && emailAndPasswordEnabled ? (
          <button
            type="button"
            onClick={() => switchView("signIn")}
            disabled={isLoading}
            className={VIEW_TOGGLE_LINK_CLASS}
          >
            {copy.signInWithPassword}
          </button>
        ) : !isEmailOtp && emailAndPasswordEnabled ? (
          <>
            {isSignUp ? copy.alreadyHaveAccount : copy.dontHaveAccount}
            <button
              type="button"
              onClick={() => switchView(isSignUp ? "signIn" : "signUp")}
              disabled={isLoading}
              className={VIEW_TOGGLE_LINK_CLASS}
            >
              {isSignUp ? copy.signIn : copy.signUp}
            </button>
            {emailOtp.enabled && (
              <>
                <span className="mx-2">·</span>
                <button
                  type="button"
                  onClick={() => switchView("emailOtp")}
                  disabled={isLoading}
                  className={VIEW_TOGGLE_LINK_CLASS}
                >
                  {copy.signInWithEmailCode}
                </button>
              </>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
