/**
 * Demo Mode — ghost cursor overlay.
 *
 * A simulated pointer that glides to targets and "clicks", giving the scripted
 * demo a live-session feel. Driven entirely by the Director's `cursor` store
 * (read via `useSyncExternalStore`); CSS transitions handle the motion, so no
 * `useEffect`.
 */
import { useSyncExternalStore } from "react";
import type { DemoStores } from "./director-stores";

export function GhostCursor({ stores }: { stores: DemoStores }) {
  const c = useSyncExternalStore(
    stores.cursor.subscribe,
    stores.cursor.get,
    stores.cursor.get,
  );
  if (!c.visible) return null;
  return (
    <div
      className="pointer-events-none fixed left-0 top-0 z-[100]"
      style={{
        transform: `translate(${c.x}px, ${c.y}px)`,
        transition: `transform ${c.moveMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
      }}
    >
      {/* click ripple */}
      <div
        className="absolute -left-3 -top-3 size-6 rounded-full border-2 border-primary"
        style={{
          opacity: c.clicking ? 0.9 : 0,
          transform: c.clicking ? "scale(1.6)" : "scale(0.4)",
          transition: "transform 200ms ease-out, opacity 200ms ease-out",
        }}
      />
      {/* pointer */}
      <svg
        width="22"
        height="22"
        viewBox="0 0 24 24"
        className="drop-shadow-[0_1px_2px_rgba(0,0,0,0.35)]"
        style={{
          transform: c.clicking ? "scale(0.85)" : "scale(1)",
          transition: "transform 120ms ease-out",
        }}
      >
        <path
          d="M5 3l14 7-6 1.6L9.5 18 5 3z"
          fill="white"
          stroke="black"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
