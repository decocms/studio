import { EmailProviderConfig } from "@/auth/email-providers";
import { MagicLinkConfig } from "@/auth/magic-link";
import { SSOConfig } from "@/auth/sso";
import {
  DEFAULT_MONITORING_CONFIG,
  type MonitoringConfig,
} from "@/monitoring/types";
import { BetterAuthOptions } from "better-auth";
import { existsSync, readFileSync } from "fs";

const DEFAULT_AUTH_CONFIG: Partial<BetterAuthOptions> = {
  emailAndPassword: {
    enabled: true,
  },
};

/**
 * Theme configuration for customizing the UI appearance.
 * Allows overriding CSS variables for light and dark modes.
 *
 * @example
 * ```json
 * {
 *   "theme": {
 *     "light": {
 *       "--primary": "oklch(0.6 0.2 250)",
 *       "--brand-green-light": "#00ff00"
 *     },
 *     "dark": {
 *       "--primary": "oklch(0.5 0.2 250)"
 *     }
 *   }
 * }
 * ```
 */
export interface ThemeConfig {
  /** CSS variable overrides for light mode */
  light?: Record<string, string>;
  /** CSS variable overrides for dark mode */
  dark?: Record<string, string>;
}

export interface Config {
  auth: Partial<BetterAuthOptions> & {
    ssoConfig?: SSOConfig;
    magicLinkConfig?: MagicLinkConfig;
    emailProviders?: EmailProviderConfig[];
    inviteEmailProviderId?: string;
    resetPasswordEmailProviderId?: string;
    jwt?: { secret?: string };
  };
  monitoring?: Partial<MonitoringConfig>;
  /**
   * Theme customization for the UI.
   * Allows overriding CSS variables for light and dark modes.
   */
  theme?: ThemeConfig;
  /**
   * Whether to automatically create an organization when a new user signs up.
   * @default true
   */
  autoCreateOrganizationOnSignup?: boolean;
}

// Config paths can be overridden via environment variables for k8s flexibility
const configPath = process.env.CONFIG_PATH || "./config.json";
const authConfigPath = process.env.AUTH_CONFIG_PATH || "./auth-config.json";

/**
 * Load optional configuration from file
 *
 * Paths can be configured via environment variables:
 * - CONFIG_PATH: Full config file path (default: ./config.json)
 * - AUTH_CONFIG_PATH: Auth config file path (default: ./auth-config.json)
 */
function loadConfig(): Config {
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(content);
      return {
        auth: DEFAULT_AUTH_CONFIG,
        monitoring: DEFAULT_MONITORING_CONFIG,
        ...parsed,
      };
    } catch {
      return {
        auth: DEFAULT_AUTH_CONFIG,
        monitoring: DEFAULT_MONITORING_CONFIG,
      };
    }
  }

  if (existsSync(authConfigPath)) {
    try {
      const content = readFileSync(authConfigPath, "utf-8");
      return {
        auth: JSON.parse(content),
        monitoring: DEFAULT_MONITORING_CONFIG,
      };
    } catch {
      return {
        auth: DEFAULT_AUTH_CONFIG,
        monitoring: DEFAULT_MONITORING_CONFIG,
      };
    }
  }

  return {
    auth: DEFAULT_AUTH_CONFIG,
    monitoring: DEFAULT_MONITORING_CONFIG,
  };
}

export const config = loadConfig();

/**
 * Get monitoring configuration with defaults
 */
export function getMonitoringConfig(): MonitoringConfig {
  return {
    ...DEFAULT_MONITORING_CONFIG,
    ...config.monitoring,
  };
}

/**
 * Get theme configuration
 */
export function getThemeConfig(): ThemeConfig | undefined {
  return config.theme;
}
