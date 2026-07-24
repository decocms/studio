import { Link, useNavigate } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";
import { AuthUIProvider } from "@daveyplate/better-auth-ui";
import type { PropsWithChildren } from "react";

export function BetterAuthUIProvider({ children }: PropsWithChildren) {
  const navigate = useNavigate();

  return (
    <AuthUIProvider
      authClient={authClient}
      redirectTo="/"
      organization={{
        basePath: "/",
        pathMode: "slug",
      }}
      navigate={(href) => navigate({ to: href })}
      replace={(href) => navigate({ to: href, replace: true })}
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
