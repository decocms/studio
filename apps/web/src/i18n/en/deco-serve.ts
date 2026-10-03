export const decoServe = {
  "decoServe.chip.disconnect": "Disconnect",
  "decoServe.chip.label": "Local server",
  "decoServe.chip.tooltip":
    "Editing the files on your machine through deco serve. Nothing is committed: review the changes and commit them yourself.",
  "decoServe.connect.invalidLinkDescription":
    "Run deco serve and open the site editor link it prints.",
  "decoServe.connect.invalidLinkTitle": "This site editor link is incomplete",
  "decoServe.connect.reaching": "Reaching {endpoint}…",
  "decoServe.connect.retry": "Try again",
  "decoServe.status.unauthorized":
    "The local server restarted with a new token. Open the link deco serve printed to reconnect.",
  "decoServe.status.unreachable":
    "The local server isn't answering. Start it with npx @decocms/blocks serve, and allow this site to reach your machine if Chrome asks.",
  "decoServe.version.v7":
    "Blocks v7: Studio reads and writes this site through its running app.",
  "decoServe.version.v8":
    "Blocks v8: Studio edits this site's content through the content protocol, without running its code.",
} as const;
