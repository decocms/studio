export const experiments = {
  "experiments.title": "Experiments",
  "experiments.subtitle":
    "A/B tests for this site. The traffic split is assigned by the deco-ab-testing Worker; results come from analytics.",
  "experiments.new": "New experiment",
  "experiments.noSite":
    "This project has no linked site, so it has no experiments.",
  "experiments.empty.title": "No experiments yet",
  "experiments.empty.desc": "Create the first A/B test for this site.",
  "experiments.summary.total": "Total",
  "experiments.status.running": "Running",
  "experiments.status.paused": "Paused",
  "experiments.status.draft": "Draft",
  "experiments.prompt.title": "Describe your A/B test",
  "experiments.prompt.subtitle":
    "Describe what you want to test in your own words — we'll turn it into a draft experiment you can review before creating it.",
  "experiments.prompt.placeholder":
    "e.g. Valentine's Day banner shows to 50% of users, doesn't show to the other 50%",
  "experiments.prompt.example1": "Seasonal banner for 50% of visitors",
  "experiments.prompt.example2": "Bigger \"Add to cart\" button",
  "experiments.prompt.example3": "Urgency copy on the PDP",
  "experiments.prompt.willGenerate":
    "Generates a test key, name, variants with traffic split, and a hypothesis — all editable before you create it.",
  "experiments.prompt.generate": "Generate",
  "experiments.prompt.generating": "Generating…",
  "experiments.prompt.editManually": "Write it manually instead",
  "experiments.prompt.backToPrompt": "Back to prompt",
  "experiments.prompt.reviewTitle": "Review before creating",
  "experiments.prompt.hypothesis": "Hypothesis",
  "experiments.prompt.regenerate": "Try a different prompt",
  "experiments.dialog.newTitle": "New experiment",
  "experiments.dialog.editTitle": "Edit experiment",
  "experiments.dialog.key": "Test key",
  "experiments.dialog.keyLocked":
    "The key can't change after creation — it's what useExperiment() and the Worker match on.",
  "experiments.dialog.name": "Name",
  "experiments.dialog.variants": "Variants",
  "experiments.dialog.weightSum": "Weights must sum to 100 (now {sum})",
  "experiments.dialog.addVariant": "Add variant",
  "experiments.dialog.create": "Create",
  "experiments.dialog.save": "Save",
  "experiments.dialog.cancel": "Cancel",
  "experiments.action.edit": "Edit",
  "experiments.action.delete": "Delete",
  "experiments.action.viewData": "View data",
  "experiments.deleteConfirm":
    'Delete experiment "{key}"? This cannot be undone.',
} as const;
