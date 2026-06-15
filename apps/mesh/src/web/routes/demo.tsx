/**
 * Public Demo Mode index (`/demo`) — a simple chooser linking to each scripted
 * demo. Each demo plays on its own URL (`/demo/<id>`).
 */
import { Link } from "@tanstack/react-router";
import { SCENARIOS } from "@/web/demo/scenarios";

export default function DemoIndexRoute() {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl">
        <h1 className="mb-1 text-2xl font-semibold text-foreground">
          Studio — live demos
        </h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Scripted walkthroughs built from the real product.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {SCENARIOS.map((s) => (
            <Link
              key={s.id}
              to="/demo/$scenario"
              params={{ scenario: s.id }}
              className="rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20"
            >
              <div className="text-base font-medium text-foreground">
                {s.title}
              </div>
              <div className="mt-1 font-mono text-xs text-muted-foreground">
                /demo/{s.id}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
