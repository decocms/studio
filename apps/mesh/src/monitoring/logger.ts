/**
 * Dedicated monitoring logger accessor.
 *
 * Monitoring telemetry (audit / tool-call / LLM-call records) flows through a
 * SEPARATE OTel LoggerProvider from infra/console logs, so the two can target
 * different OTLP collectors and sampling policies:
 *   - infra logs  → global LoggerProvider, sampled (INFRA_LOG_SAMPLE_RATIO)
 *   - monitoring  → this provider, 100% (no sampling), customer-facing dashboard
 *
 * This module holds the reference to the monitoring provider's Logger, wired by
 * initObservability() via setMonitoringLoggerProvider(). It is intentionally
 * tiny (no SDK imports) so emit.ts — and its unit tests — don't pull in the full
 * NodeSDK module graph.
 */

import {
  type Logger,
  type LoggerProvider,
  NOOP_LOGGER,
} from "@opentelemetry/api-logs";

const MONITORING_LOGGER_NAME = "studio.monitoring";
const MONITORING_LOGGER_VERSION = "1.0.0";

let monitoringLogger: Logger = NOOP_LOGGER;

/**
 * Wire the dedicated monitoring LoggerProvider. Called once by
 * initObservability() after the provider is constructed.
 */
export function setMonitoringLoggerProvider(provider: LoggerProvider): void {
  monitoringLogger = provider.getLogger(
    MONITORING_LOGGER_NAME,
    MONITORING_LOGGER_VERSION,
  );
}

/**
 * Get the monitoring logger. Returns a no-op logger until observability is
 * initialized (e.g. in unit tests that skip initObservability()), so callers
 * never need a null check.
 */
export function getMonitoringLogger(): Logger {
  return monitoringLogger;
}
