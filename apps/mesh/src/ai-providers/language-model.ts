/**
 * Language model factory.
 *
 * `createLanguageModel` now lives in the portable harnesses subtree
 * (`@/harnesses/decopilot/mesh-provider`) so the shared Decopilot core and the
 * desktop daemon use ONE implementation. This re-export keeps every existing
 * `@/ai-providers/language-model` importer compiling unchanged.
 */

export { createLanguageModel } from "@/harnesses/decopilot/mesh-provider";
