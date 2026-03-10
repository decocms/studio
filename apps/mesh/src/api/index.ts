/**
 * Deco Studio API Server - Main Entry Point
 *
 * Re-exports createApp and provides a default app instance for production.
 * Tests should import { createApp } from "./app" to avoid side effects.
 */

export { createApp, type CreateAppOptions } from "./app";

// Default app instance for production use
// This runs createApp() immediately on module load
import { createApp } from "./app";
export default await createApp();
