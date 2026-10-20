import { useState, useSyncExternalStore } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { LinkExternal01 } from "@untitledui/icons";
import { z } from "zod";
import { useT } from "@/i18n/use-t.ts";
import type { AuthenticateMcpResult } from "@/sdk";

/**
 * Sign-in for MCP servers that accept only Claude Code's OAuth client: Claude
 * Code signs in inside a temporary sandbox and redirects to localhost there,
 * so the user pastes back the address their browser could not open.
 */

const tokenInfoSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().nullable(),
  expiresIn: z.number().nullable(),
  scope: z.string().nullable(),
  clientId: z.string().nullable(),
  clientSecret: z.string().nullable(),
  tokenEndpoint: z.string().nullable(),
});

interface SignIn {
  base: string;
  authUrl: string | null;
  resolve: (result: AuthenticateMcpResult) => void;
}

let current: SignIn | null = null;
const listeners = new Set<() => void>();
const setCurrent = (next: SignIn | null) => {
  current = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const failed = (error: string): AuthenticateMcpResult => ({
  token: null,
  tokenInfo: null,
  error,
});

async function postJson(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const error =
      json && typeof json === "object" && "error" in json ? json.error : null;
    throw new Error(typeof error === "string" ? error : res.statusText);
  }
  return json;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Resolves when the user finishes or closes the dialog. */
export async function signInFromSandbox(
  orgSlug: string,
  connectionId: string,
): Promise<AuthenticateMcpResult> {
  current?.resolve(failed("Sign-in replaced by a newer one"));
  const base = `/api/${encodeURIComponent(orgSlug)}/connections/${connectionId}/sandbox-sign-in`;
  return new Promise((resolve) => {
    const signIn: SignIn = { base, authUrl: null, resolve };
    setCurrent(signIn);
    postJson(base, {})
      .then((json) => {
        const { authUrl } = z.object({ authUrl: z.url() }).parse(json);
        if (current === signIn) setCurrent({ ...signIn, authUrl });
      })
      .catch((err) => {
        if (current === signIn) setCurrent(null);
        resolve(failed(errorText(err)));
      });
  });
}

/** Mounted once; shows the sign-in `signInFromSandbox` is waiting on. */
export function SandboxSignInDialog() {
  const t = useT();
  const signIn = useSyncExternalStore(subscribe, () => current);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = (result: AuthenticateMcpResult) => {
    signIn?.resolve(result);
    setCurrent(null);
    setCallbackUrl("");
    setError(null);
  };

  const finish = async () => {
    if (!signIn) return;
    setPending(true);
    setError(null);
    try {
      const tokenInfo = tokenInfoSchema.parse(
        await postJson(`${signIn.base}/finish`, {
          callbackUrl: callbackUrl.trim(),
        }),
      );
      close({
        token: tokenInfo.accessToken,
        tokenInfo: { ...tokenInfo, idToken: null, userinfoEndpoint: null },
        error: null,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={signIn !== null}
      onOpenChange={(open) => {
        if (!open) close(failed("Sign-in cancelled"));
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("connections.sandboxSignIn.title")}</DialogTitle>
          <DialogDescription>
            {t("connections.sandboxSignIn.description")}
          </DialogDescription>
        </DialogHeader>
        {signIn?.authUrl ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void finish();
            }}
          >
            <Button asChild variant="outline">
              <a
                href={signIn.authUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <LinkExternal01 className="size-4" />
                {t("connections.sandboxSignIn.openSignIn")}
              </a>
            </Button>
            <p className="text-sm text-muted-foreground">
              {t("connections.sandboxSignIn.pasteHint")}
            </p>
            <Input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://localhost:…/callback?code=…"
              aria-label={t("connections.sandboxSignIn.callbackLabel")}
              required
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={pending}>
              {t("connections.sandboxSignIn.finish")}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("connections.sandboxSignIn.starting")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
