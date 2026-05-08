import { createContext, useContext, type ReactNode } from "react";
import type { AuthConfig } from "@/api/routes/auth";
import { usePublicConfig } from "@/web/hooks/use-public-config";

const AuthConfigContext = createContext<AuthConfig | undefined>(undefined);

export function AuthConfigProvider({ children }: { children: ReactNode }) {
  const publicConfig = usePublicConfig();

  return (
    <AuthConfigContext.Provider value={publicConfig.auth}>
      {children}
    </AuthConfigContext.Provider>
  );
}

export function useAuthConfig() {
  const context = useContext(AuthConfigContext);
  if (context === undefined) {
    throw new Error("useAuthConfig must be used within AuthConfigProvider");
  }
  return context;
}
