export interface ThemeConfig {
  light?: Record<string, string>;
  dark?: Record<string, string>;
}

/**
 * Authentication capabilities exposed by the public Studio configuration
 * endpoint. This is intentionally distinct from the server's private auth
 * environment configuration.
 */
export interface AuthConfig {
  emailAndPassword: {
    enabled: boolean;
  };
  magicLink: {
    enabled: boolean;
  };
  emailOtp: {
    enabled: boolean;
  };
  socialProviders: {
    enabled: boolean;
    providers: {
      name: string;
      icon?: string;
    }[];
  };
  resetPassword: {
    enabled: boolean;
  };
  sso:
    | {
        enabled: true;
        providerId: string;
      }
    | {
        enabled: false;
      };
  /**
   * Whether STDIO connections are allowed. This is only true in local mode,
   * where the server may spawn local commands.
   */
  stdioEnabled: boolean;
  /** Whether the zero-ceremony local authentication mode is active. */
  localMode: boolean;
}

/** Public, unauthenticated deployment configuration consumed by the web app. */
export interface PublicConfig {
  /** Studio release version used to detect a stale browser bundle. */
  version: string;
  theme?: ThemeConfig;
  logo?: string | { light: string; dark: string };
  internalUrl?: string;
  enableDecoImport?: boolean;
  brandExtractEnabled?: boolean;
  auth: AuthConfig;
  posthog: { key: string; host: string } | null;
  googleMapsApiKey: string | null;
  runtime: {
    agentSandbox: boolean;
  };
}
