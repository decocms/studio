// Moved to the portable harness tree. This shim keeps the legacy
// `@/api/routes/decopilot/mode-config` specifier working for cluster-only
// callers; new code imports from `@/harnesses/decopilot/mode-config`.
export * from "@/harnesses/lib/decopilot/mode-config";
