import type { GuidePrompt, GuideResource } from "./index";

export const prompts: GuidePrompt[] = [
  {
    name: "setup-ai-provider",
    description:
      "Configure an AI provider and confirm the model setup is usable.",
    text: `# Set up AI provider

Goal: configure an AI provider credential flow correctly and verify the workspace can use it.

Read docs://ai-providers.md for provider types, authentication options, and credit checks.

Recommended tool order:
1. Use AI_PROVIDERS_LIST to inspect available providers.
2. If the user has not chosen a provider or auth method, use user_ask.
3. For API-key providers, use AI_PROVIDER_KEY_CREATE.
4. For OAuth providers, use AI_PROVIDER_OAUTH_URL and complete the exchange flow with AI_PROVIDER_OAUTH_EXCHANGE.
5. Use AI_PROVIDER_KEY_LIST or AI_PROVIDERS_ACTIVE to confirm configuration.
6. If relevant, use AI_PROVIDERS_LIST_MODELS and AI_PROVIDER_CREDITS for model availability and balance checks.

Checks:
- Match the provider to the user's model or routing needs.
- Use the correct auth flow: API key or OAuth.
- Confirm the provider becomes active or otherwise available after setup.
- Surface low-credit or no-credit states when they may block usage.
`,
  },
];

export const resources: GuideResource[] = [
  {
    name: "ai-providers",
    uri: "docs://ai-providers.md",
    description: "AI provider options, auth flows, and credit/model guidance.",
    text: `# AI providers

## Purpose

AI providers supply the models and credentials Decopilot and agents use for generation.

## Common provider types

### Direct providers
- Examples: Anthropic, OpenAI, Google.
- Usually map directly to a vendor's models and credentials.

### Aggregators
- Example: OpenRouter.
- Provide access to multiple model families through one account.
- Useful when the user wants flexibility across vendors.

## Authentication flows

### API key
- The most common setup.
- Use a provider-issued secret key.
- Confirm whether the workspace should store one shared credential or replace an existing one.

### OAuth
- Some providers use a browser authorization flow.
- Expect a URL step followed by a code exchange.
- The setup is not complete until the exchange succeeds.

## Model discovery

- Use provider/model listing tools to confirm the desired model exists.
- Do not assume every provider exposes every model family.

## Credits and readiness

- Some providers require account balance or credits before requests succeed.
- Check credits when the provider supports it, especially if the user reports generation failures.

## Practical guidance

- Start with the provider that matches the user's preferred model.
- Use an aggregator when cross-provider access matters more than vendor-specific features.
- After setup, verify the provider is active and that the intended model is available.
`,
  },
];
