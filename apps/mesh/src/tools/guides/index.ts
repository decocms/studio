import * as agents from "./agents";
import * as aiProviders from "./ai-providers";
import * as automations from "./automations";
import * as connections from "./connections";
import * as platform from "./platform";
import * as store from "./store";
import * as virtualTools from "./virtual-tools";

export interface GuidePrompt {
  name: string;
  description: string;
  text: string;
}

export interface GuideResource {
  name: string;
  uri: string;
  description: string;
  text: string;
  mimeType?: string;
}

export function getPrompts(): GuidePrompt[] {
  return [
    ...agents.prompts,
    ...connections.prompts,
    ...store.prompts,
    ...automations.prompts,
    ...aiProviders.prompts,
    ...virtualTools.prompts,
  ];
}

export function getResources(): GuideResource[] {
  return [
    ...platform.resources,
    ...agents.resources,
    ...connections.resources,
    ...store.resources,
    ...automations.resources,
    ...aiProviders.resources,
    ...virtualTools.resources,
  ];
}
