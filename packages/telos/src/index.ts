// @decocms/telos — domain-agnostic goal-pursuit agent core. This entrypoint is
// IO-free and AI-free; the optional LLM deliberator lives at "@decocms/telos/ai",
// and the Socratic/Platonic pieces at "/daimonion", "/elenchus", "/demiurge".

export * from "./core";
export { ruleDeliberator } from "./deliberators/rule";
