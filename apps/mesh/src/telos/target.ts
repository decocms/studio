// The org's first goal: connect a few SPECIFIC, high-value integrations — not a
// blind count. Each tool is matched against a real connection's app/name, so
// "connect GitHub and a CMS" is concretely measurable (and meaningful), where
// "connect 3 tools" never was.
export interface ToolTarget {
  // Human-facing name, e.g. "GitHub".
  label: string;
  // Lowercase keywords matched (substring) against a connection's app_name /
  // slug / title, e.g. ["github"].
  match: string[];
  // Registry binding id used to install the app in-place
  // (useInstallFromRegistry.installByBinding), e.g. "@deco/github".
  appName?: string;
  icon?: string;
}

export interface OnboardingTarget {
  // Concrete, outcome-framed, e.g. "Connect GitHub and a CMS to automate release notes".
  title: string;
  tools: ToolTarget[];
}
