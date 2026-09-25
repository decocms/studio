export const projects = {
  // Platforms
  "projects.platform.vtex": "VTEX",
  "projects.platform.shopify": "Shopify",
  "projects.platform.wake": "Wake",
  "projects.platform.nuvemshop": "Nuvemshop",
  "projects.platform.linx": "Linx",
  "projects.platform.vnda": "VNDA",

  // Home
  "projects.home.newProject": "New project",

  // Card
  "projects.card.updated": "Updated {time}",

  // Empty state
  "projects.empty.title": "Your commerce, one project at a time",
  "projects.empty.description":
    "A site, an app, a store. Each one keeps its own connections, report and board.",
  "projects.empty.readOnly": "Ask an admin to create the first project.",

  // Creation dialog
  "projects.new.title": "New project",
  "projects.new.subtitle": "What are you setting up?",
  "projects.new.back": "Back",
  "projects.new.create": "Create project",
  "projects.new.creating": "Creating…",
  "projects.new.nameLabel": "Project name",
  "projects.new.namePlaceholder": "Farm web",
  "projects.new.nameRequired": "Give the project a name",
  "projects.new.failed": "Couldn't create the project",
  "projects.new.created": "{title} is ready",

  "projects.new.path.repository": "Import a codebase",
  "projects.new.path.repository.hint": "Bring a storefront or app codebase in",
  "projects.new.path.folder": "New project folder",
  "projects.new.path.folder.hint": "Name it now, connect it later",

  "projects.new.step.folder.title": "Name your project",

  // Reports index
  "projects.reports.chooserTitle": "Continue to Reports",
  "projects.reports.chooserSubtitle": "Choose a project to continue",
  "projects.reports.chooserSearch": "Find project\u2026",
  "projects.reports.chooserEmpty": "No project by that name.",
  "projects.reports.status.ready": "Ready",
  "projects.reports.status.running": "Running",
  "projects.reports.status.none": "Not run",
  "projects.reports.status.locked": "Locked",

  "projects.connections.orgWide": "Organization-wide",
  "projects.connections.usedBy": "{count} projects",
  // Settings › Projects
  "projects.settings.title": "Projects",
  "projects.settings.description":
    "Everything scoped to a project lives here: its repositories, connections, report and board.",
  "projects.settings.searchPlaceholder": "Search projects…",
  "projects.settings.open": "Open",
  "projects.settings.openSettings": "Settings",
  "projects.settings.orgScopeNote":
    "Members, billing, security and AI providers stay organization-wide.",
  "projects.settings.noResults": "No projects match “{search}”",

  // Project settings › identity
  "projects.identity.storeUrlLabel": "Store URL",
  "projects.identity.storeUrlDescription":
    "The live storefront. Reports run against this address.",
  "projects.flat.viewProject": "Project",
  "projects.flat.viewFiles": "Files",
  "projects.apps.heading": "Apps",
  "projects.apps.reports": "Report",
  "projects.apps.reportsCaption": "What is wrong with the storefront",
  "projects.apps.siteEditor": "Site editor",
  "projects.apps.siteEditorCaption": "Pages, sections and content",
  "projects.apps.assets": "Assets",
  "projects.apps.assetsCaption": "Images and files the site uses",
  "projects.apps.hosting": "Hosting",
  "projects.apps.hostingCaption": "Deploys, domains and environments",
  "projects.apps.e2e": "End-to-end tests",
  "projects.apps.e2eCaption": "Flows checked on every change",
  "projects.apps.analytics": "Analytics",
  "projects.apps.analyticsCaption": "Traffic, conversion and revenue",
  "projects.apps.cdn": "Monitor",
  "projects.apps.cdnCaption": "Cache, latency and errors",
  "projects.apps.automations": "Automations",
  "projects.apps.automationsCaption": "Work that runs on a schedule",
  "projects.apps.experiments": "Experiments",
  "projects.apps.experimentsCaption": "A/B tests and their results",
  "projects.flat.close": "Close",
} as const;
