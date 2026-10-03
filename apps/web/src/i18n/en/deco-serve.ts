export const decoServe = {
  "decoServe.chip.disconnect": "Disconnect",
  "decoServe.chip.label": "Local server",
  "decoServe.chip.tooltip":
    "Editing the files on your machine through deco serve. Nothing is committed: review the changes and commit them yourself.",
  "decoServe.connect.invalidLinkDescription":
    "Run deco serve and open the site editor link it prints.",
  "decoServe.connect.invalidLinkTitle": "This connect link is incomplete",
  "decoServe.connect.noProjects":
    "This organization has no projects yet. Import the site's repository first.",
  "decoServe.connect.notEnabledDescription":
    "Editing a local server isn't enabled for this organization.",
  "decoServe.connect.notEnabledTitle": "Not available",
  "decoServe.connect.pickDescription":
    "Pick the project for {root}, served at {endpoint}.",
  "decoServe.connect.pickTitle": "Connect your local server",
  "decoServe.connect.reaching": "Reaching {endpoint}…",
  "decoServe.connect.retry": "Try again",
  "decoServe.status.unauthorized":
    "The local server restarted with a new token. Open the link deco serve printed to reconnect.",
  "decoServe.status.unreachable":
    "The local server isn't answering. Start it with npx @decocms/blocks serve, and allow this site to reach your machine if Chrome asks.",
} as const;
