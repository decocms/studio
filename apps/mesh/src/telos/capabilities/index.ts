// Importing this barrel loads every capability for its `defineCapability` side
// effect (populating CAPABILITIES). app boot imports it before
// registerTelosCapabilities() so the registry sees them all.
import "./onboarding-research";
