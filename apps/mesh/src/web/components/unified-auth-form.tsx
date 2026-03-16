import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

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
}

type FormView = "signIn" | "signUp" | "forgotPassword" | "emailOtp";

export function UnifiedAuthForm({
  redirectUrl,
  callbackUrl = "/",
}: UnifiedAuthFormProps) {
  const { emailAndPassword, resetPassword, emailOtp, socialProviders } =
    useAuthConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [view, setView] = useState<FormView>(() => {
    if (!emailAndPassword.enabled && emailOtp.enabled) {
      return "emailOtp";
    }
    const hasLoggedIn = globalThis.localStorage?.getItem("hasLoggedIn");
    return hasLoggedIn !== "true" ? "signUp" : "signIn";
  });
  const [emailError, setEmailError] = useState("");
  const [resetEmailSent, setResetEmailSent] = useState(false);

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
            throw new Error(result.error.message || "Sign up failed");
          }
          return result;
        } else {
          const result = await authClient.signIn.email({ email, password });
          if (result.error) {
            throw new Error(result.error.message || "Sign in failed");
          }
          return result;
        }
      } catch (err) {
        throw err instanceof Error ? err : new Error("Authentication failed");
      }
    },
    onSuccess: () => {
      globalThis.localStorage?.setItem("hasLoggedIn", "true");
      window.location.href = redirectUrl ?? callbackUrl;
    },
  });

  const forgotPasswordMutation = useMutation({
    mutationFn: async ({ email }: { email: string }) => {
      const result = await authClient.requestPasswordReset({
        email,
        redirectTo: "/reset-password",
      });
      if (result.error) {
        throw new Error(result.error.message || "Failed to send reset email");
      }
      return result;
    },
    onSuccess: () => {
      setResetEmailSent(true);
    },
  });

  const sendOtpMutation = useMutation({
    mutationFn: async ({ email }: { email: string }) => {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "sign-in",
      });
      if (result.error) {
        throw new Error(result.error.message || "Failed to send code");
      }
      return result;
    },
    onSuccess: () => {
      setOtpSent(true);
    },
  });

  const verifyOtpMutation = useMutation({
    mutationFn: async ({ email, otp }: { email: string; otp: string }) => {
      const result = await authClient.signIn.emailOtp({
        email,
        otp,
      });
      if (result.error) {
        throw new Error(result.error.message || "Invalid code");
      }
      return result;
    },
    onSuccess: () => {
      globalThis.localStorage?.setItem("hasLoggedIn", "true");
      window.location.href = redirectUrl ?? callbackUrl;
    },
  });

  const validateEmail = (email: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleEmailBlur = () => {
    if (email.trim() && !validateEmail(email)) {
      setEmailError("Invalid email address");
    }
  };

  const handleEmailPassword = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError("Invalid email address");
      return;
    }

    emailPasswordMutation.mutate({ email, password, name });
  };

  const handleForgotPassword = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError("Invalid email address");
      return;
    }

    forgotPasswordMutation.mutate({ email });
  };

  const handleSendOtp = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateEmail(email)) {
      setEmailError("Invalid email address");
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
      return "Invalid email or password. Please try again.";
    }

    if (
      errorMessage.includes("already exists") ||
      errorMessage.includes("409")
    ) {
      return "An account with this email already exists. Try signing in instead.";
    }

    if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      return "Network error. Please check your connection and try again.";
    }

    if (errorMessage.includes("rate limit") || errorMessage.includes("429")) {
      return "Too many attempts. Please wait a moment and try again.";
    }

    if (errorMessage.includes("invalid") && errorMessage.includes("otp")) {
      return "Invalid or expired code. Please try again.";
    }

    return error.message || "An error occurred. Please try again.";
  };

  const displayError = error || forgotPasswordError || otpError;

  const headerText = isForgotPassword
    ? "Reset your password"
    : isEmailOtp
      ? otpSent
        ? "Enter verification code"
        : "Sign in with email code"
      : isSignUp
        ? "Create your account"
        : "Login or signup below";

  return (
    <div className="mx-auto w-full min-w-[400px] max-w-md grid gap-6 bg-card p-10 border border-primary-foreground/20">
      {/* Logo */}
      <div className="flex justify-center">
        <img src="/logos/deco logo.svg" alt="Deco" className="h-12 w-12" />
      </div>

      {/* Header */}
      <div className="text-center space-y-1">
        <p className="text-sm text-foreground/70">{headerText}</p>
      </div>

      {/* Error message */}
      {displayError && (
        <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
          {getErrorMessage(displayError)}
        </div>
      )}

      {/* Success message for forgot password */}
      {resetEmailSent && (
        <div className="rounded-xl bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400 text-center">
          Check your email for a password reset link.
        </div>
      )}

      {/* Social Provider Buttons */}
      {!isForgotPassword && !isEmailOtp && socialProviders.enabled && (
        <div className="grid gap-3">
          {socialProviders.providers.map((provider) => (
            <Button
              key={provider.name}
              type="button"
              variant="outline"
              size="lg"
              className="w-full font-medium"
              disabled={isLoading}
              onClick={() => {
                authClient.signIn.social({
                  provider: provider.name,
                  callbackURL: redirectUrl ?? callbackUrl,
                });
              }}
            >
              {provider.icon && (
                <img
                  src={provider.icon}
                  alt=""
                  className="h-5 w-5"
                  aria-hidden="true"
                />
              )}
              Continue with{" "}
              {provider.name.charAt(0).toUpperCase() + provider.name.slice(1)}
            </Button>
          ))}
        </div>
      )}

      {/* Divider between social and email-based auth */}
      {!isForgotPassword &&
        !isEmailOtp &&
        socialProviders.enabled &&
        (emailAndPassword.enabled || emailOtp.enabled) && (
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        )}

      {/* Email OTP Form */}
      {isEmailOtp && emailOtp.enabled && (
        <>
          {!otpSent ? (
            <form onSubmit={handleSendOtp} className="grid gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Email
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
                />
                {emailError && (
                  <p className="text-xs text-destructive mt-1.5">
                    {emailError}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={isLoading || !canSubmit}
                className="w-full font-semibold"
                size="lg"
              >
                {isLoading ? "Sending..." : "Send code"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyOtp} className="grid gap-4">
              <div className="rounded-xl bg-muted/50 p-3 text-sm text-muted-foreground text-center">
                Code sent to {email}
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Verification code
                </label>
                <Input
                  type="text"
                  placeholder="Enter code"
                  value={otp}
                  onChange={handleInputChange(setOtp)}
                  required
                  disabled={isLoading}
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                />
              </div>

              <Button
                type="submit"
                disabled={isLoading || !canSubmit}
                className="w-full font-semibold"
                size="lg"
              >
                {isLoading ? "Verifying..." : "Verify"}
              </Button>

              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setOtpSent(false);
                  setOtp("");
                  sendOtpMutation.reset();
                  verifyOtpMutation.reset();
                }}
                disabled={isLoading}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Use a different email
              </Button>
            </form>
          )}
        </>
      )}

      {/* Forgot Password Form */}
      {isForgotPassword && emailAndPassword.enabled && !resetEmailSent && (
        <form onSubmit={handleForgotPassword} className="grid gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Email
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
            />
            {emailError && (
              <p className="text-xs text-destructive mt-1.5">{emailError}</p>
            )}
          </div>

          <Button
            type="submit"
            disabled={isLoading || !canSubmit}
            className="w-full font-semibold"
            size="lg"
          >
            {isLoading ? "Sending..." : "Send reset link"}
          </Button>
        </form>
      )}

      {/* Email & Password Form */}
      {!isForgotPassword && !isEmailOtp && emailAndPassword.enabled && (
        <form onSubmit={handleEmailPassword} className="grid gap-4">
          <div
            className={cn(
              "overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.075,0.82,0.165,1)]",
              isSignUp
                ? "max-h-[200px] opacity-100 translate-y-0"
                : "max-h-0 opacity-0 -translate-y-2",
            )}
          >
            <div className={cn("p-1", !isSignUp && "pointer-events-none")}>
              <label className="block text-sm font-medium text-foreground mb-2">
                Name
              </label>
              <Input
                type="text"
                placeholder="Your name"
                value={name}
                onChange={handleInputChange(setName)}
                required
                disabled={isLoading || !isSignUp}
                aria-hidden={!isSignUp}
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Email
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
            />
            {emailError && (
              <p className="text-xs text-destructive mt-1.5">{emailError}</p>
            )}
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-foreground">
                Password
              </label>
              {!isSignUp && resetPassword.enabled && (
                <button
                  type="button"
                  onClick={() => switchView("forgotPassword")}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Forgot password?
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
                size="lg"
                aria-hidden={!canSubmit}
              >
                {isLoading
                  ? isSignUp
                    ? "Creating account..."
                    : "Signing in..."
                  : "Continue"}
              </Button>
            </div>
          </div>
        </form>
      )}

      {/* Email OTP toggle - show when both email/password and OTP are available */}
      {!isForgotPassword &&
        emailOtp.enabled &&
        emailAndPassword.enabled &&
        !isEmailOtp && (
          <div className="text-center">
            <Button
              type="button"
              variant="link"
              onClick={() => switchView("emailOtp")}
              disabled={isLoading}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Sign in with email code instead
            </Button>
          </div>
        )}

      {/* Back to password sign-in from OTP view */}
      {isEmailOtp && emailAndPassword.enabled && (
        <div className="text-center">
          <Button
            type="button"
            variant="link"
            onClick={() => switchView("signIn")}
            disabled={isLoading}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign in with password instead
          </Button>
        </div>
      )}

      {/* View toggle links */}
      <div className="text-center">
        {isForgotPassword ? (
          <Button
            type="button"
            variant="link"
            onClick={() => switchView("signIn")}
            disabled={isLoading}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Back to sign in
          </Button>
        ) : !isEmailOtp && emailAndPassword.enabled ? (
          <Button
            type="button"
            variant="link"
            onClick={() => switchView(isSignUp ? "signIn" : "signUp")}
            disabled={isLoading}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {isSignUp
              ? "Already have an account? Sign in"
              : "Don't have an account? Sign up"}
          </Button>
        ) : null}
      </div>

      {/* Terms */}
      <div className="flex justify-between text-xs text-muted-foreground pt-4">
        <a
          href="https://www.decocms.com/terms-of-use"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          Terms of Service
        </a>
        <a
          href="https://www.decocms.com/privacy-policy"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-foreground transition-colors"
        >
          Privacy Policy
        </a>
      </div>
    </div>
  );
}
