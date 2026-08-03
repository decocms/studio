import { Link } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";
import { router } from "@/router";
import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import type { PropsWithChildren } from "react";

// `BetterAuthUIProvider` is mounted above `<RouterProvider>` (see
// index.web.tsx) so its context reaches route components too. That means
// `useNavigate()` can't be used here — it resolves the router via React
// context, which isn't established yet at this point in the tree, and
// silently returns a null router in production (only warns in dev). Use the
// `router` singleton's imperative `.navigate()` instead; it works regardless
// of where in the tree it's called from.
export function BetterAuthUIProvider({ children }: PropsWithChildren) {
  return (
    <AuthUIProvider
      authClient={authClient}
      redirectTo="/"
      organization={{
        basePath: "/",
        pathMode: "slug",
      }}
      navigate={(href) => router.navigate({ to: href })}
      replace={(href) => router.navigate({ to: href, replace: true })}
      Link={({ href, className, children, ...props }) => (
        <Link to={href} className={className} {...props}>
          {children}
        </Link>
      )}
    >
      {children}
    </AuthUIProvider>
  );
}
