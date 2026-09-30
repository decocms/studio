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
  "experiments.prompt.example2": 'Bigger "Add to cart" button',
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
  "experiments.prompt.regeneratePlaceholder":
    "Something wrong? Describe the fix and regenerate.",
  "experiments.dialog.newTitle": "New experiment",
  "experiments.dialog.editTitle": "Edit experiment",
  "experiments.dialog.key": "Test key",
  "experiments.dialog.keyLocked":
    "The key can't change after creation — it's what useExperiment() and the Worker match on.",
  "experiments.dialog.name": "Name",
  "experiments.dialog.variants": "Variants",
  "experiments.dialog.variantDescriptionPlaceholder":
    'What this arm will look like on the front (e.g. "the Deals item is hidden from the navbar")',
  "experiments.dialog.weightSum": "Weights must sum to 100 (now {sum})",
  "experiments.dialog.addVariant": "Add variant",
  "experiments.dialog.create": "Create",
  "experiments.dialog.save": "Save",
  "experiments.dialog.cancel": "Cancel",
  "experiments.action.back": "Back to list",
  "experiments.action.edit": "Edit",
  "experiments.action.preview": "Preview",
  "experiments.preview.baseline": "baseline",
  "experiments.preview.updatePreview": "Update preview",
  "experiments.preview.notSyncedYet":
    'Click "Update preview" to render this draft on the local site.',
  "experiments.preview.noUrlTitle": "No preview URL for this site",
  "experiments.preview.noUrlDesc":
    "This project has no preview/production URL set, so variants can't be rendered here.",
  "experiments.preview.saveChanges": "Save changes",
  "experiments.preview.control": "Control",
  "experiments.preview.treatment": "Treatment",
  "experiments.preview.trafficTitle": "Traffic distribution",
  "experiments.preview.trafficDesc":
    "Set the visitor percentage for each variant. Must sum to 100%.",
  "experiments.preview.distributionValid": "Valid distribution",
  "experiments.preview.variantsTitle": "Variants",
  "experiments.preview.variantsDesc":
    "See how each variant renders on the site.",
  "experiments.preview.openPage": "Open page",
  "experiments.confirm.title": 'Create "{key}" and proceed?',
  "experiments.confirm.withImplement":
    "This will also write the useExperiment() hook and its gate directly into the local site's code — no sandbox, no PR. Best-effort: if it can't confidently find the right spot, it leaves the code untouched and you'll see that below.",
  "experiments.confirm.withoutImplement":
    "No variant has a description to implement from, so this only creates the draft — nothing on the frontend changes yet.",
  "experiments.confirm.proceed": "Yes, create",
  "experiments.confirm.proceedWithImplement": "Yes, create and implement",
  "experiments.action.delete": "Delete",
  "experiments.action.implement": "Implement with Super Agent",
  "experiments.implementConfirm":
    'Delegate implementing "{key}" to the Super Agent? It will find the affected component, wire it up, and open a PR — no further review before that PR.',
  "experiments.action.viewData": "View data",
  "experiments.deleteConfirm":
    'Delete experiment "{key}"? This cannot be undone.',
} as const;
