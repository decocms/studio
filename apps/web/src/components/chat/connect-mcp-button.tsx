import { useState } from "react";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Link01, LinkExternal01 } from "@untitledui/icons";
import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

async function postJson(url: string, body: object): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
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

/**
 * Signs the sandbox's Claude Code in to an OAuth MCP server. Claude Code
 * redirects to localhost inside the sandbox, so the user pastes back the
 * address their browser could not open.
 */
export function ConnectMcpButton({
  sandboxUrl,
}: {
  /** Null until the chat's first message gives it a sandbox. */
  sandboxUrl: ((path: string) => string) | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [pending, setPending] = useState(false);

  const reset = () => {
    setAuthUrl(null);
    setCallbackUrl("");
  };

  const start = async () => {
    setPending(true);
    try {
      if (!sandboxUrl) return;
      const json = await postJson(sandboxUrl("mcp-login"), {
        name: name.trim(),
        url: serverUrl.trim(),
      });
      const link =
        json && typeof json === "object" && "authUrl" in json
          ? json.authUrl
          : null;
      if (typeof link !== "string") throw new Error("No sign-in URL returned");
      setAuthUrl(link);
    } catch (err) {
      toast.error(t("sandbox.connectMcp.failed", { error: errorText(err) }));
    } finally {
      setPending(false);
    }
  };

  const finish = async () => {
    setPending(true);
    try {
      if (!sandboxUrl) return;
      await postJson(sandboxUrl("mcp-login/finish"), {
        callbackUrl: callbackUrl.trim(),
      });
      toast.success(t("sandbox.connectMcp.connected", { name: name.trim() }));
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(t("sandbox.connectMcp.failed", { error: errorText(err) }));
    } finally {
      setPending(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1"
          disabled={!sandboxUrl}
          title={sandboxUrl ? undefined : t("sandbox.connectMcp.needsSandbox")}
        >
          <Link01 className="size-3.5" />
          {t("sandbox.connectMcp.button")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-2 text-xs">
        {authUrl === null ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <p className="text-muted-foreground">
              {t("sandbox.connectMcp.intro")}
            </p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="figma"
              aria-label={t("sandbox.connectMcp.nameLabel")}
              pattern="[A-Za-z0-9_\-]{1,64}"
              required
            />
            <Input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://mcp.figma.com/mcp"
              aria-label={t("sandbox.connectMcp.urlLabel")}
              type="url"
              required
            />
            <Button type="submit" size="sm" disabled={pending}>
              {t("sandbox.connectMcp.start")}
            </Button>
          </form>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void finish();
            }}
          >
            <Button asChild variant="outline" size="sm">
              <a href={authUrl} target="_blank" rel="noopener noreferrer">
                <LinkExternal01 className="size-3.5" />
                {t("sandbox.connectMcp.openSignIn")}
              </a>
            </Button>
            <p className="text-muted-foreground">
              {t("sandbox.connectMcp.pasteHint")}
            </p>
            <Input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://localhost:…/callback?code=…"
              aria-label={t("sandbox.connectMcp.callbackLabel")}
              required
            />
            <Button type="submit" size="sm" disabled={pending}>
              {t("sandbox.connectMcp.finish")}
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}
