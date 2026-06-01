import type { ReactNode } from "react";

// Subtle brand aurora bled in from the edges, using the three brand accent
// colors from the design tokens (packages/ui global.css):
//   --brand-purple-light #a595ff, --brand-green-light #d0ec1a,
//   --brand-yellow-light #ffc116
// Same radial-gradient overlay pattern as the Deco nudge card / credits banner,
// kept low-opacity so it reads as branded but never competes with content.
const BRAND_GRADIENT = [
  "radial-gradient(ellipse 85% 85% at 0% 0%, rgba(165,149,255,0.6) 0%, transparent 72%)",
  "radial-gradient(ellipse 85% 85% at 100% 100%, rgba(208,236,26,0.52) 0%, transparent 72%)",
  "radial-gradient(ellipse 85% 85% at 0% 100%, rgba(255,193,22,0.48) 0%, transparent 72%)",
].join(", ");

/**
 * Full-screen centered shell shared by every org access-gate screen
 * (no-access, not-found, pending invite, auto domain join, archived org).
 * Provides the branded gradient background so these pages feel like part of
 * the product instead of a bare error page.
 */
export function AccessScreenLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: BRAND_GRADIENT }}
      />
      <div className="relative flex flex-col items-center text-center space-y-4 max-w-sm px-6">
        {children}
      </div>
    </div>
  );
}
