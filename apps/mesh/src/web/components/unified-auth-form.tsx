import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useAuthConfig } from "@/web/providers/auth-config-provider";
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

const RESEND_COOLDOWN_SECONDS = 60;

interface UnifiedAuthFormProps {
  /**
   * URL to redirect to after successful authentication.
   * Used for OAuth flows to redirect back to the authorize endpoint.
   */
  redirectUrl?: string | null;
}

type FormView = "email" | "otp";

export function UnifiedAuthForm({ redirectUrl }: UnifiedAuthFormProps) {
  const { emailOTP } = useAuthConfig();
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [view, setView] = useState<FormView>("email");
  const [emailError, setEmailError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  const cooldownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isOtpView = view === "otp";

  const startResendCooldown = () => {
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    if (cooldownRef.current) clearInterval(cooldownRef.current);
    cooldownRef.current = setInterval(() => {
      setResendCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownRef.current) clearInterval(cooldownRef.current);
          cooldownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Send OTP to email
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
      setView("otp");
      startResendCooldown();
    },
  });

  // Verify OTP and sign in
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
      // Validate redirectUrl is a safe relative path
      if (
        redirectUrl &&
        redirectUrl.startsWith("/") &&
        !redirectUrl.startsWith("//")
      ) {
        window.location.href = redirectUrl;
      } else {
        window.location.href = "/";
      }
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

  const handleOtpSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateEmail(email)) {
      setEmailError("Invalid email address");
      return;
    }
    sendOtpMutation.mutate({ email });
  };

  const handleOtpVerify = (e: React.FormEvent) => {
    e.preventDefault();
    verifyOtpMutation.mutate({ email, otp });
  };

  const isLoading = sendOtpMutation.isPending || verifyOtpMutation.isPending;
  const otpError = sendOtpMutation.error || verifyOtpMutation.error;

  const handleInputChange =
    (setter: (value: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      if (otpError) {
        sendOtpMutation.reset();
        verifyOtpMutation.reset();
      }
      if (setter === setEmail && emailError) {
        setEmailError("");
      }
    };

  const switchToEmail = () => {
    setView("email");
    setOtp("");
    setEmailError("");
    sendOtpMutation.reset();
    verifyOtpMutation.reset();
  };

  const canSubmit = isOtpView ? otp.trim().length > 0 : email.trim().length > 0;

  const getErrorMessage = (error: Error | null) => {
    if (!error) return null;

    const errorMessage = error.message.toLowerCase();

    if (errorMessage.includes("network") || errorMessage.includes("fetch")) {
      return "Network error. Please check your connection and try again.";
    }

    if (errorMessage.includes("rate limit") || errorMessage.includes("429")) {
      return "Too many attempts. Please wait a moment and try again.";
    }

    if (
      errorMessage.includes("invalid") &&
      (errorMessage.includes("otp") || errorMessage.includes("code"))
    ) {
      return "Invalid verification code. Please try again.";
    }

    return error.message || "An error occurred. Please try again.";
  };

  const headerText = isOtpView
    ? "Enter verification code"
    : "Sign in with email";

  if (!emailOTP.enabled) {
    return null;
  }

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
      {otpError && (
        <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
          {getErrorMessage(otpError)}
        </div>
      )}

      {/* Email Step */}
      {!isOtpView && (
        <form onSubmit={handleOtpSend} className="grid gap-4">
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
                className="w-full font-semibold"
                size="lg"
                aria-hidden={!canSubmit}
              >
                {isLoading ? "Sending code..." : "Continue with email"}
              </Button>
            </div>
          </div>
        </form>
      )}

      {/* OTP Verification Step */}
      {isOtpView && (
        <form onSubmit={handleOtpVerify} className="grid gap-4">
          <div className="text-center text-sm text-muted-foreground">
            We sent a code to{" "}
            <span className="font-medium text-foreground">{email}</span>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              Verification code
            </label>
            <Input
              type="text"
              placeholder="Enter verification code"
              value={otp}
              onChange={handleInputChange(setOtp)}
              required
              disabled={isLoading}
              autoFocus
              inputMode="numeric"
              pattern="[0-9]*"
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

          <div className="flex justify-between text-xs">
            <button
              type="button"
              onClick={switchToEmail}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              Use a different email
            </button>
            <button
              type="button"
              onClick={() => {
                verifyOtpMutation.reset();
                setOtp("");
                sendOtpMutation.mutate({ email });
              }}
              disabled={isLoading || resendCooldown > 0}
              className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              {resendCooldown > 0
                ? `Resend code (${resendCooldown}s)`
                : "Resend code"}
            </button>
          </div>
        </form>
      )}

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
