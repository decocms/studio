/**
 * Demo Mode — desktop-link flow visuals (agents scenario).
 *
 * Faithful re-creation of `ConnectDesktopDialog` (same Dialog primitives + copy)
 * plus a mocked iTerm window running `bunx decocms link`, driven by demo ui
 * state instead of live link queries:
 *   ui.inputs["link"]   = "" | "waiting" | "connected"
 *   ui.inputs["iterm"]  = "" | "open" | "min"
 *   ui.inputs["iterm:text"] = terminal contents (typed by the Director)
 */
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { Copy01 } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import type { DemoStores } from "./director-stores";
import { useDemoInput } from "./use-demo-stores";

export function DemoLinkDialog({ stores }: { stores: DemoStores }) {
  const state = useDemoInput(stores, "link");
  const online = state === "connected";
  const open = state !== "";

  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {online ? "Desktop connected" : "Connect your desktop"}
          </DialogTitle>
          <DialogDescription>
            {online
              ? "Your desktop is online. Pick a desktop agent in the chat to use it."
              : "Run this command in your desktop terminal. The dialog will close once your desktop is online."}
          </DialogDescription>
        </DialogHeader>

        {!online && (
          <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-sm">
            <span className="flex-1">bunx decocms link</span>
            <Copy01 size={14} className="text-muted-foreground" />
          </div>
        )}

        {!online ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" />
            Waiting for desktop…
          </div>
        ) : (
          <div className="flex flex-col gap-1 text-sm">
            <p className="text-foreground">MacBook Pro is linked.</p>
            <p className="text-muted-foreground">
              Available: Claude Code, Codex
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ITermWindow({ stores }: { stores: DemoStores }) {
  const state = useDemoInput(stores, "iterm");
  const text = useDemoInput(stores, "iterm:text");
  if (state !== "open" && state !== "min") return null;
  const minimized = state === "min";
  return (
    <div
      className="pointer-events-none fixed left-1/2 top-24 z-[90] w-[560px] max-w-[90vw] overflow-hidden rounded-xl shadow-2xl"
      style={{
        transformOrigin: "bottom center",
        transform: minimized
          ? "translate(-50%, 70vh) scale(0.35)"
          : "translate(-50%, 0) scale(1)",
        opacity: minimized ? 0 : 1,
        transition:
          "transform 600ms cubic-bezier(0.5, 0, 0.75, 0), opacity 600ms ease-in",
      }}
    >
      {/* title bar */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: "#2b2b33" }}
      >
        <span className="flex gap-1.5">
          <span
            className="size-3 rounded-full"
            style={{ background: "#ff5f57" }}
          />
          <span
            className="size-3 rounded-full"
            style={{ background: "#febc2e" }}
          />
          <span
            className="size-3 rounded-full"
            style={{ background: "#28c840" }}
          />
        </span>
        <span
          className="mx-auto font-mono text-xs"
          style={{ color: "#b8b8c0" }}
        >
          claude-code — bunx decocms link — 80×24
        </span>
      </div>
      {/* terminal body */}
      <div
        className="min-h-[220px] px-4 py-3 font-mono text-[13px] leading-relaxed"
        style={{ background: "#16161e", color: "#d7d7e0" }}
      >
        <pre className="whitespace-pre-wrap">{text}</pre>
        <span
          className={cn("inline-block", !minimized && "animate-pulse")}
          style={{
            width: 8,
            height: 16,
            background: "#7dd3fc",
            verticalAlign: "text-bottom",
          }}
        />
      </div>
    </div>
  );
}
