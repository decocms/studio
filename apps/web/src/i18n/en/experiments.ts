export const experiments = {
  "experiments.title": "Experiments",
  "experiments.new": "New experiment",
  "experiments.noSite":
    "This project has no linked site, so it has no experiments.",
  "experiments.empty.title": "No experiments yet",
  "experiments.empty.desc":
    "Show two versions of a page to real visitors and see which one sells more.",
  "experiments.status.running": "Running",
  "experiments.status.paused": "Paused",
  "experiments.status.draft": "Draft",
  "experiments.prompt.title": "New experiment",
  "experiments.prompt.subtitle":
    "Say what you want to test. You can review everything before it goes live.",
  "experiments.prompt.placeholder":
    "e.g. Show a Valentine's Day banner to half of the visitors",
  "experiments.prompt.example1": "Seasonal banner for 50% of visitors",
  "experiments.prompt.example2": 'Bigger "Add to cart" button',
  "experiments.prompt.example3": "Urgency copy on the PDP",
  "experiments.prompt.willGenerate": "We draft the name, variants and split.",
  "experiments.prompt.generate": "Generate",
  "experiments.prompt.generating": "Generating…",
  "experiments.prompt.creating": "Creating and opening the PR…",
  "experiments.prompt.editManually": "Write it manually",
  "experiments.prompt.hypothesis": "Hypothesis",
  "experiments.prompt.regenerate": "Try a different prompt",
  "experiments.prompt.regeneratePlaceholder":
    "Something wrong? Describe the fix and regenerate.",
  "experiments.dialog.key": "Test key",
  "experiments.dialog.name": "Name",
  "experiments.dialog.variantDescriptionPlaceholder":
    "Describe what this version shows",
  "experiments.dialog.create": "Create",
  "experiments.dialog.cancel": "Cancel",
  "experiments.preview.updatePreview": "Update preview",
  "experiments.preview.notSyncedYet":
    'Click "Update preview" to render this draft on the local site.',
  "experiments.preview.noUrlTitle": "No preview URL for this site",
  "experiments.preview.noUrlDesc":
    "This project has no preview/production URL set, so variants can't be rendered here.",
  "experiments.preview.saveChanges": "Save changes",
  "experiments.preview.control": "Control",
  "experiments.implementation.notDelegated":
    "No code has been written for this experiment yet.",
  "experiments.implementation.delegate": "Write the code",
  "experiments.implementation.writing":
    "The Super Agent is writing the code. It opens a pull request when it's done.",
  "experiments.implementation.deploying":
    "Pull request #{number} is open — waiting for its preview deploy to compare before and after.",
  "experiments.implementation.ready":
    "Comparing production (control) with pull request #{number}'s preview (treatment).",
  "experiments.implementation.merged":
    "Pull request #{number} is merged — the change is on the site itself.",
  "experiments.implementation.viewImplementation": "Follow implementation",
  "experiments.implementation.viewPr": "View pull request",
  "experiments.preview.openPage": "Open page",
  "experiments.confirm.title": 'Create "{key}" and start implementing?',
  "experiments.confirm.withImplement":
    "The Super Agent starts writing the code on the site now and opens a PR — no further review before that PR. The experiment is created either way, even if implementation can't start (a site with no linked repository, for instance).",
  "experiments.confirm.withoutImplement":
    "No variant has a description to implement from, so this only creates the draft — nothing on the frontend changes yet.",
  "experiments.confirm.proceed": "Yes, create",
  "experiments.confirm.proceedWithImplement": "Create and implement",
  "experiments.action.delete": "Delete",
  "experiments.action.implement": "Open a PR with the code",
  "experiments.implementConfirm":
    'Delegate implementing "{key}" to the Super Agent? It will find the affected component, wire it up, and open a PR — no further review before that PR.',
  "experiments.action.viewData": "View data",
  "experiments.deleteConfirm":
    'Delete experiment "{key}"? This cannot be undone.',
  "experiments.status.ended": "Ended",
  "experiments.meta.today": "today",
  "experiments.meta.daysAgo": "{days}d ago",
  "experiments.meta.started": "Started {when}",
  "experiments.meta.created": "Created {when}",
  "experiments.meta.ended": "Ended {when}",
  "experiments.action.start": "Start test",
  "experiments.action.pause": "Pause",
  "experiments.action.resume": "Resume",
  "experiments.action.end": "End test",
  "experiments.action.more": "More actions",
  "experiments.split.seeChange": "see a change",
  "experiments.split.even": "Even split",
  "experiments.split.reset": "Reset",
  "experiments.compare.compare": "Compare",
  "experiments.compare.desktop": "Desktop",
  "experiments.compare.mobile": "Mobile",
  "experiments.compare.handle": "Drag to compare",
  "experiments.deleteTitle": "Delete this experiment?",
  "experiments.implementTitle": "Implement with Super Agent?",
  "experiments.implementProceed": "Delegate",
  "experiments.action.rename": "Rename",
  "experiments.split.addVariant": "Add variant",
  "experiments.split.removeVariant": "Remove variant",
  "experiments.split.variantName": "Variant name",
  "experiments.filter.label": "Filter",
  "experiments.filter.status": "Status",
  "experiments.filter.searchLabel": "Search experiments",
  "experiments.filter.searchPlaceholder": "Search experiments…",
  "experiments.filter.searchClear": "Clear search",
  "experiments.filter.empty": "No experiments match these filters.",
  "experiments.split.editPercent": "Edit {label} percentage",
  "experiments.compare.pickVariant": "Choose the variant to compare",
  "experiments.compare.openArm": "Open {arm} in a new tab",
  "experiments.prompt.shortcut": "⌘ Enter",
  "experiments.prompt.tryOne": "Or start from an idea",

  // Read only by experiments-tab-legacy.tsx; both go when the flag does.
  "experiments.subtitle":
    "Compare versions of this site with real traffic and see which one converts better.",
  "experiments.col.name": "Name",
  "experiments.col.key": "Key",
  "experiments.col.status": "Status",
  "experiments.col.variants": "Variants",
  "experiments.dialog.newTitle": "New experiment",
  "experiments.legacy.dialog.key": "Matcher block name",
  "experiments.dialog.variants": "Variants",
  "experiments.dialog.weightSum": "Weights must sum to 100 (now {sum})",
  "experiments.dialog.addVariant": "Add variant",
  "experiments.action.back": "Back to list",
  "experiments.results.title": "Results",
  "experiments.results.unavailable":
    "Analytics isn't configured for this deployment, so results are unavailable here.",
  "experiments.results.noSiteData":
    "No analytics traffic found for {site}. The site may not be sending analytics events yet, or its traffic is reported under another site.",
  "experiments.results.empty": "No participants yet for this experiment.",
  "experiments.results.control": "Control",
  "experiments.results.test": "Test",
  "experiments.results.variant": "Variant",
  "experiments.results.weight": "{weight}% of traffic",
  "experiments.results.arm": "Version",
  "experiments.results.armsTitle": "Versions",
  "experiments.results.visitors": "Visitors",
  "experiments.results.visitorsHint":
    "Counted once a day: someone who comes back on another day counts again.",
  "experiments.results.exposed": "Exposed",
  "experiments.results.exposedHint":
    "Visitors who reached the point where the versions differ, in both versions. The fairest base for the comparison.",
  "experiments.results.conversion": "Conversion",
  "experiments.results.conversionHintExposed":
    "Of the exposed visitors, the share who reached the goal “{goal}”.",
  "experiments.results.conversionHintVisitors":
    "Of all visitors, the share who reached the goal “{goal}”.",
  "experiments.results.difference": "Difference",
  "experiments.results.reference": "Baseline",
  "experiments.results.range": "{low} to {high}",
  "experiments.results.orders": "Orders",
  "experiments.results.revenue": "Revenue",
  "experiments.results.revenuePerVisitor": "Revenue per visitor",
  "experiments.results.averageOrder": "Average order",
  "experiments.results.differenceHint":
    "How much the test converts above or below control, and the range the real difference falls in with 95% confidence.",
  "experiments.results.verdict.few": "Not enough data yet",
  "experiments.results.verdict.unclear": "No clear difference yet",
  "experiments.results.verdict.better": "“{arm}” converts more",
  "experiments.results.verdict.worse": "“{arm}” converts less",
  "experiments.results.verdict.notWorse":
    "“{arm}” is not worse than “{control}”",
  "experiments.results.verdict.compareExposed":
    "“{test}” converts {testRate} of {exposed} visitors, against {controlRate} for “{control}”.",
  "experiments.results.verdict.compareVisitors":
    "“{test}” converts {testRate} of its visitors, against {controlRate} for “{control}”.",
  "experiments.results.verdict.noBase":
    "Control has no conversions yet, so there is nothing to compare against.",
  "experiments.results.verdict.fewHint":
    "Each version needs at least {total} visitors and {successes} conversions before the comparison means anything.",
  "experiments.results.claim.lower":
    "The difference isn't {significant} yet, so the lower number doesn't mean “{test}” is losing.",
  "experiments.results.claim.higher":
    "The difference isn't {significant} yet, so the higher number doesn't mean “{test}” is winning.",
  "experiments.results.claim.even": "The difference isn't {significant} yet.",
  "experiments.results.claim.notWorse":
    "The difference isn't {significant} yet, but a drop larger than {bar} is already ruled out.",
  "experiments.results.claim.better":
    "The increase is {significant}, so the measured number counts.",
  "experiments.results.claim.worse":
    "The drop is {significant}, too large to be chance.",
  "experiments.results.range.cross":
    "The real result can be anywhere from {low} worse to {high} better.",
  "experiments.results.range.above":
    "The real result is between {near} and {far} better.",
  "experiments.results.range.below":
    "The real result is between {near} and {far} worse.",
  "experiments.results.fact.better": "Chance “{test}” is better",
  "experiments.results.fact.target": "Chance it is at least {target} better",
  "experiments.results.fact.safety": "Not worse than {bar}",
  "experiments.results.safety.open": "Can't say yet",
  "experiments.results.safety.openNote":
    "To say so, the measured difference has to reach {bar}.",
  "experiments.results.safety.notWorse": "Yes, traffic can grow",
  "experiments.results.safety.worse": "No, the drop is significant",
  "experiments.results.chanceAbove": "Over 99%",
  "experiments.results.chanceBelow": "Under 1%",
  "experiments.results.forecast.left":
    "At the current pace, it reaches ±{margin} in {days} more days, with {exposed} more exposed.",
  "experiments.results.forecast.leftOne":
    "At the current pace, it reaches ±{margin} in 1 more day, with {exposed} more exposed.",
  "experiments.results.forecast.reached": "Already under ±{margin}.",
  "experiments.results.forecast.unknown":
    "Not enough data yet to estimate when it narrows.",
  "experiments.results.progress.running": "Running for {days} days.",
  "experiments.results.progress.runningOne": "Running for 1 day.",
  "experiments.results.progress.evenSplit":
    "With half the traffic on each version, the margin would reach ±{margin} in {days} days.",
  "experiments.results.progress.evenSplitOne":
    "With half the traffic on each version, the margin would reach ±{margin} in 1 day.",
  "experiments.results.liftTrend": "Running difference",
  "experiments.results.liftTrendHint":
    "Each point adds up every day so far. A wide band early on is normal: with few orders, one good or bad day moves the result a lot.",
  "experiments.results.chart.aria":
    "Conversion difference of “{test}” against “{control}”, {lift}, with a 95% range of {range}.",
  "experiments.results.chart.worse": "Worse",
  "experiments.results.chart.better": "Better",
  "experiments.results.chart.measured": "Measured difference",
  "experiments.results.chart.measuredTotal": "Difference with all days so far",
  "experiments.results.chart.range": "95% range",
  "experiments.results.chart.bar": "{bar} limit",
  "experiments.results.chart.tooltip":
    "Measured {lift}, with a 95% range of {range}.",
  "experiments.results.chart.tooltipDay": "Difference so far {lift}",
  "experiments.results.glossary.significant": "significant",
  "experiments.results.glossary.significantTitle": "Significant",
  "experiments.results.glossary.significantHint":
    "Too large to be chance. Here, when there is at least 95% confidence that the real difference goes the way it measured.",
  "experiments.results.glossary.exposed": "exposed",
  "experiments.results.glossary.exposedTitle": "Exposed",
  "experiments.results.glossary.exposedHint":
    "A visitor who reached the part of the site that differs between versions. Conversion is measured among them, each counted once per day they visit.",
  "experiments.results.glossary.margin": "Margin",
  "experiments.results.glossary.marginTitle": "Margin",
  "experiments.results.glossary.marginHint":
    "How much the result can still move by chance alone, up or down, with 95% confidence. It narrows as the test adds days.",
  "experiments.results.howTo.title": "How to read this result",
  "experiments.results.howTo.range":
    "The bar shows where the real difference probably is. While it crosses zero, winning and losing are both still possible, even with the measured point on one side.",
  "experiments.results.howTo.early":
    "Early on, a few orders move the difference a lot. One good or bad day in either version changes the whole result, so the band starts wide and narrows.",
  "experiments.results.howTo.looks":
    "Decide on the running total, never on a single day. Every look at the result is another chance to see a difference that is only chance, and deciding on the best day ends up deciding wrong.",
  "experiments.results.howTo.calendar":
    "Day of the week and novelty also move the first days, and the band doesn't include them.",
  "experiments.results.howTo.method":
    "The math follows deco's A/B rollout plan: one-sided 95% confidence on the ratio of conversion rates, a flat prior, and a {deff} design effect because visitors are split once and each counts once per day. The test can grow once it is not worse than {bar}, and an increase only counts when it is significant.",
  "experiments.results.trend": "Conversion by day",
  "experiments.results.behaviour": "Behaviour per visitor",
  "experiments.results.pageviews": "Pages viewed",
  "experiments.results.pageviewsHint": "Average pages viewed per visitor.",
  "experiments.results.activeTime": "Active time",
  "experiments.results.activeTimeHint":
    "Average time per visitor with the page open and in use.",
  "experiments.results.clicks": "Clicks",
  "experiments.results.clicksHint": "Average clicks per visitor.",
  "experiments.results.scroll": "Median scroll",
  "experiments.results.scrollHint":
    "How far down the page a typical visit scrolls.",
  "experiments.results.jsErrors": "Visitors with JS errors",
  "experiments.results.jsErrorsHint":
    "Visitors of this version who had at least one JavaScript error on any page of the site.",
  "experiments.results.minutes": "{m} min {s} s",
  "experiments.results.seconds": "{s} s",
  "experiments.results.goals": "Goals",
  "experiments.results.goalsHint": "Visitors who reached each goal.",
  "experiments.results.goalName.purchase": "Purchase",
  "experiments.results.goalName.experience_impression": "Exposure",
  "experiments.results.goal": "Goal",
  "experiments.results.sourceDeco": "Source: Deco Analytics",
  "experiments.v8.intro":
    "Your A/B tests are part of your site's content. Every change is saved in your draft and goes live when you publish.",
  "experiments.v8.new": "New A/B test",
  "experiments.v8.allTests": "All A/B tests",
  "experiments.v8.empty.title": "No A/B tests yet",
  "experiments.v8.empty.desc":
    "Create one here, or from a variant in the site editor: choose the rule “A/B test” and type a name.",
  "experiments.v8.status.off": "Off",
  "experiments.v8.status.running": "Running",
  "experiments.v8.status.everyone": "Everyone",
  "experiments.v8.state.new": "Not published yet",
  "experiments.v8.state.changed": "Changed in your draft",
  "experiments.v8.removedTitle": "Removed in your draft",
  "experiments.v8.removedHint":
    "These tests stop when you publish. To keep one, create it again with the same name.",
  "experiments.v8.shareLabel": "Visitors who see the test",
  "experiments.v8.shareTitle": "Who sees the test",
  "experiments.v8.split.inTest": "See the test",
  "experiments.v8.split.rest": "See the page as it is",
  "experiments.v8.split.center": "see the test",
  "experiments.v8.split.reset": "Back to {share}%",
  "experiments.v8.shareHint":
    "Drag the slider, or use the arrow keys. 0 turns the test off, 100 shows it to everyone. Each visitor keeps the side they got.",
  "experiments.v8.publishedShare": "Published: {share}% of visitors",
  "experiments.v8.save": "Save",
  "experiments.v8.turnOff": "Turn off",
  "experiments.v8.showEveryone": "Show to everyone",
  "experiments.v8.delete": "Delete test",
  "experiments.v8.deleted": "Test “{name}” deleted from your draft",
  "experiments.v8.deletedHint":
    "It leaves the site when you publish. Undo brings it back.",
  "experiments.v8.missing.title": "Your site needs an update for A/B tests",
  "experiments.v8.missing.desc":
    "Ask your developer to update the site to the latest version of Blocks and publish it. Your tests will show up here.",
  "experiments.v8.replaced.title":
    "Your site handles A/B tests in its own code",
  "experiments.v8.replaced.desc":
    "Its developers defined their own tests, so they can't be changed here. Ask them how to change one.",
  "experiments.v8.conflict.title":
    "Your site already has a block named “experiments”",
  "experiments.v8.conflict.desc":
    "It isn't a list of A/B tests, so tests can't be added yet. Rename that block in the site editor, then come back here.",
  "experiments.v8.noDraft.title": "Pick a draft to edit your tests",
  "experiments.v8.noDraft.desc":
    "Your tests are saved in a draft, like any other edit. Pick a draft in the bar above, or open the site editor to start one.",
  "experiments.v8.loadFailed": "Couldn't load your tests.",
  "experiments.v8.previewHint":
    "To see a test on or off before publishing, use “Preview as” in the site editor's preview.",
  "experiments.live.title": "Live now",
  "experiments.live.intro": "What visitors get on the published site.",
  "experiments.live.edit": "Edit in Experiments",
  "experiments.live.editTest": "Edit",
  "experiments.live.viewInMonitor": "View in Monitor",
  "experiments.live.unpublished":
    "Your draft has A/B test changes that aren't published yet.",
  "experiments.live.unpublishedTest":
    "Your draft changes this test; it isn't published yet.",
  "experiments.live.removedTest":
    "Your draft removes this test; it stays live until you publish.",
  "experiments.live.notLive": "“{name}” isn't live yet.",
  "experiments.live.editNamed": "Edit {name} in Experiments",
  "experiments.live.editRow": "Edit {name}",
  "experiments.live.unknown.title": "Couldn't read what's live",
  "experiments.live.unknown.desc":
    "Your draft changes the A/B tests, and their published copy couldn't be read. Try again in a moment.",
  "experiments.live.empty.title": "No A/B tests live",
  "experiments.live.empty.desc": "Create one in Experiments and publish it.",
  "experiments.live.noDraft.title": "Pick a draft to see what's live",
  "experiments.live.noDraft.desc":
    "What's live is read through a draft. Pick one in Experiments to see this site's tests here.",
  "experiments.live.noDraft.action": "Pick a draft in Experiments",
} as const;
