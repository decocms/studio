export const experiments = {
  "experiments.title": "Experiments",
  "experiments.subtitle":
    "A/B tests for this site. The traffic split lives in the site's content; results come from analytics.",
  "experiments.new": "New experiment",
  "experiments.noSite":
    "This project has no linked site, so it has no experiments.",
  "experiments.empty.title": "No experiments yet",
  "experiments.empty.desc": "Create the first A/B test for this site.",
  "experiments.col.name": "Name",
  "experiments.col.key": "Key",
  "experiments.col.status": "Status",
  "experiments.col.variants": "Variants",
  "experiments.dialog.newTitle": "New experiment",
  "experiments.dialog.key": "Matcher block name",
  "experiments.dialog.name": "Name",
  "experiments.dialog.variants": "Variants",
  "experiments.dialog.weightSum": "Weights must sum to 100 (now {sum})",
  "experiments.dialog.addVariant": "Add variant",
  "experiments.dialog.create": "Create",
  "experiments.dialog.cancel": "Cancel",
  "experiments.action.back": "Back to list",
  "experiments.action.delete": "Delete",
  "experiments.deleteConfirm":
    'Delete experiment "{key}"? This cannot be undone.',
  "experiments.results.title": "Results",
  "experiments.results.unavailable":
    "Analytics isn't configured for this deployment, so results are unavailable here.",
  "experiments.results.noSiteData":
    "No analytics traffic found for {site}. The site may not be sending analytics events yet, or its traffic is reported under another site.",
  "experiments.results.empty": "No participants yet for this experiment.",
  "experiments.results.control": "Control",
  "experiments.results.variant": "Variant",
  "experiments.results.visitors": "Visitors",
  "experiments.results.participants": "Participants",
  "experiments.results.sampleSize": "Target sample size",
  "experiments.results.probBest": "Probability variant best",
  "experiments.results.goal": "Goal",
} as const;
