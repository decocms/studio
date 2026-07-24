/**
 * Monitoring Configuration Constants
 *
 * Centralized configuration for the monitoring dashboard.
 */

export const MONITORING_CONFIG = {
  /**
   * Maximum characters to render in syntax highlighter.
   * Prevents browser crash with large JSON payloads.
   */
  maxJsonRenderSize: 50_000, // ~50KB

  /**
   * Number of logs to fetch per page.
   */
  pageSize: 50,

  /**
   * Interval for streaming/live updates in milliseconds.
   */
  streamingRefetchInterval: 3000,
} as const;

export type MonitoringConfig = typeof MONITORING_CONFIG;
