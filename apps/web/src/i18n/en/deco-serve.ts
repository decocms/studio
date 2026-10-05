/**
 * The site editor's local connection (`/site-editor` and the "Local" draft
 * option): what `deco serve` is doing and the one thing to do next. Text in
 * backticks renders as code (`RichCode`); commands and flags stay in English.
 */
export const decoServe = {
  "decoServe.chip.label": "Local server",
  "decoServe.chip.tooltip":
    "Editing the files on this computer through deco serve. Nothing is committed: you review the changes and commit them yourself.",
  "decoServe.chip.readOnly": "Read-only",
  "decoServe.chip.readOnlyTooltip":
    "deco serve was started with `--read-only`, so changes can't be saved. Restart it without that flag to edit.",
  "decoServe.connect.reaching": "Connecting to deco serve on {host}…",

  "decoServe.guide.title": "Edit your site's content on your computer",
  "decoServe.guide.lead":
    "The site editor turns the content files of a site on this computer into forms. Changes are saved to those files, and nothing is committed: you review them and commit them yourself.",
  "decoServe.guide.step1.title": "Start deco serve in your site's folder",
  "decoServe.guide.step1.body":
    "In a terminal, in your site's folder (the one that has the `.deco` folder), run:",
  "decoServe.guide.step1.preview":
    "The Preview tab shows your app on the port in your Vite config, or localhost:5173. If it runs somewhere else, add `--preview` with its address, such as `--preview localhost:3000`.",
  "decoServe.guide.copy": "Copy command",
  "decoServe.guide.copyShort": "Copy",
  "decoServe.guide.copied": "Copied",
  "decoServe.guide.copiedAnnouncement": "Command copied to the clipboard",
  "decoServe.guide.step2.title": "This page connects on its own",
  "decoServe.guide.step2.body":
    "Leave this tab open. The editor opens here as soon as deco serve starts, with no link to click.",
  "decoServe.guide.step2.looking": "Looking for deco serve on {hosts}…",
  "decoServe.guide.step2.paused":
    "Paused while this tab is in the background. It looks again when you come back.",
  "decoServe.guide.step2.start": "Look for deco serve on this computer",
  "decoServe.guide.v7":
    "Working on an older Deco site (deco.cx or @decocms/start)? deco serve is for Blocks v8 sites. Open the site from its Studio project and choose Local in the draft selector.",
  "decoServe.guide.checkingFirst": "Looking for deco serve…",

  "decoServe.docs.heading": "Learn more",
  "decoServe.docs.quickstart": "Quickstart",
  "decoServe.docs.siteEditor": "Site editor guide",
  "decoServe.docs.serve": "deco serve options",
  "decoServe.docs.schema": "deco schema",
  "decoServe.docs.troubleshooting": "Troubleshooting",
  "decoServe.docs.newTab": "(opens in a new tab)",

  "decoServe.link.invalidTitle":
    "This link doesn't point to deco serve on your computer",
  "decoServe.link.invalidBody":
    "Site editor links only open a deco serve running on this computer (localhost). Copy the Site editor link again from your terminal, or follow the steps below.",
  "decoServe.lna.deniedTitle":
    "Chrome is blocking Studio from reaching your computer",
  "decoServe.lna.deniedBody":
    "Studio needs permission to connect to deco serve on this computer. Click the icon at the left of the address bar, allow access to apps on this device (local network access), then reload this page.",

  "decoServe.state.notAnswering.title": "deco serve isn't answering",
  "decoServe.state.notAnswering.short":
    "deco serve on {host} isn't answering. Reconnecting on its own when it's back.",
  "decoServe.state.outdated.title": "This deco serve is out of date",
  "decoServe.state.outdated.body":
    "The server on {host} asks for an access token, as older versions of deco serve did. Update @decocms/blocks in your site to the latest version, then start deco serve again.",
  "decoServe.state.versionMismatch.title":
    "This Studio and deco serve don't match",
  "decoServe.state.versionMismatch.body":
    "deco serve on {host} comes from a different major version of Blocks than this Studio, so they can't edit content together. Update @decocms/blocks in your site and restart deco serve.",
  "decoServe.state.notDecoServe.title": "Another program is using {host}",
  "decoServe.state.notDecoServe.body":
    "Something other than deco serve answered on {host}. Start deco serve on another port with `--port 4546` and open the Site editor link it prints.",
  "decoServe.state.error.title": "deco serve couldn't open your content",
  "decoServe.state.error.body":
    'It answered, but with an error: "{detail}". Check the terminal where deco serve runs for details, then try again.',

  "decoServe.save.conflict":
    "Not saved: this content changed on your computer after you opened it (in your code editor or by git, for example). Studio is loading the latest version. Make your change again on top of it.",
  "decoServe.save.readOnly":
    "Not saved: deco serve is read-only (started with --read-only). Restart it without that flag to save.",
  "decoServe.save.invalid":
    "Not saved: deco serve rejected this content: {detail}",
  "decoServe.save.tooLarge":
    "Not saved: this content is larger than deco serve accepts. Make it smaller and try again.",
  "decoServe.save.serverGone":
    "Not saved: deco serve stopped answering. Start it again, then repeat the change.",
  "decoServe.upload.failed": "Couldn't upload {name}: {detail}",
  "decoServe.upload.serverGone":
    "Couldn't upload {name}: deco serve stopped answering. Start it again and retry.",
  "decoServe.upload.readOnly":
    "Couldn't upload {name}: deco serve is read-only (started with --read-only).",

  "decoServe.version.v7":
    "Blocks v7: Studio reads and saves content through your running site.",
  "decoServe.version.v8":
    "Blocks v8: Studio edits your site's content files directly, without running your site's code.",
} as const;
