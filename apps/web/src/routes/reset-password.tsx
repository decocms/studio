import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { useT } from "@/i18n/use-t.ts";

export default function ResetPasswordRoute() {
  const t = useT();
  const { token, error: tokenError } = useSearch({ from: "/reset-password" });
  const navigate = useNavigate();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [success, setSuccess] = useState(false);

  const hasTokenError = tokenError === "INVALID_TOKEN";

  const resetMutation = useMutation({
    mutationFn: async ({
      newPassword,
      token,
    }: {
      newPassword: string;
      token: string;
    }) => {
      const result = await authClient.resetPassword({
        newPassword,
        token,
      });
      if (result.error) {
        throw new Error(result.error.message || "Failed to reset password");
      }
      return result;
    },
    onSuccess: () => {
      setSuccess(true);
    },
  });

  const passwordsMatch = newPassword === confirmPassword;
  const canSubmit =
    newPassword.length >= 8 && confirmPassword.length >= 8 && passwordsMatch;
  const isLoading = resetMutation.isPending;
  const error = resetMutation.error;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !canSubmit) return;
    resetMutation.mutate({ newPassword, token });
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-gradient-to-br from-primary to-primary/75 p-4">
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(circle, var(--primary-foreground) 1px, transparent 1px)`,
          backgroundSize: "16px 16px",
          opacity: 0.15,
        }}
      />

      <div className="relative z-10">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-screen h-px bg-primary-foreground/15" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-screen h-px bg-primary-foreground/15" />
        <div className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-screen bg-primary-foreground/15" />
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-px h-screen bg-primary-foreground/15" />

        <div className="mx-auto w-full min-w-[400px] max-w-md grid gap-6 bg-card p-10 border border-primary-foreground/20">
          {/* Logo */}
          <div className="flex justify-center">
            <img src="/logos/deco logo.svg" alt="Deco" className="h-12 w-12" />
          </div>

          {/* Header */}
          <div className="text-center space-y-1">
            <p className="text-sm text-foreground/70">
              {success
                ? t("routes.resetPassword.passwordResetSuccessful")
                : t("routes.resetPassword.setNewPassword")}
            </p>
          </div>

          {/* Invalid / expired token */}
          {(hasTokenError || (!token && !success)) && (
            <>
              <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
                {t("routes.resetPassword.invalidOrExpiredLink")}
              </div>
              <Button
                onClick={() => navigate({ to: "/login" })}
                className="w-full font-semibold"
                size="lg"
              >
                {t("routes.resetPassword.backToLogin")}
              </Button>
            </>
          )}

          {/* Error from API */}
          {error && (
            <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive text-center">
              {error.message || t("routes.resetPassword.failedToReset")}
            </div>
          )}

          {/* Success state */}
          {success && (
            <>
              <div className="rounded-xl bg-success/10 p-3 text-sm text-success text-center">
                {t("routes.resetPassword.passwordResetDescription")}
              </div>
              <Button
                onClick={() => navigate({ to: "/login" })}
                className="w-full font-semibold"
                size="lg"
              >
                {t("routes.resetPassword.goToLogin")}
              </Button>
            </>
          )}

          {/* Reset form */}
          {token && !hasTokenError && !success && (
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t("routes.resetPassword.newPasswordLabel")}
                </label>
                <Input
                  type="password"
                  placeholder="••••••••"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={isLoading}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t("routes.resetPassword.confirmPasswordLabel")}
                </label>
                <Input
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  disabled={isLoading}
                />
                {confirmPassword && !passwordsMatch && (
                  <p className="text-xs text-destructive mt-1.5">
                    {t("routes.resetPassword.passwordsDoNotMatch")}
                  </p>
                )}
              </div>

              <Button
                type="submit"
                disabled={isLoading || !canSubmit}
                className="w-full font-semibold"
                size="lg"
              >
                {isLoading
                  ? t("routes.resetPassword.resetting")
                  : t("routes.resetPassword.resetPassword")}
              </Button>
            </form>
          )}

          {/* Back to login link */}
          {!success && (
            <div className="text-center">
              <Button
                type="button"
                variant="link"
                onClick={() => navigate({ to: "/login" })}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                {t("routes.resetPassword.backToSignIn")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
