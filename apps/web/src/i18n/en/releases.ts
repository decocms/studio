/**
 * The Releases screen of a hosted site (the `releases` route). Business-user
 * copy: "Latest" is the release your last publish made the newest; "Make
 * current" publishes a new release with an earlier one's content (the note it
 * writes says "Made current: …"), and "Preview this version" opens an earlier
 * release in a preview. "Make current" is that action's name everywhere it is
 * spoken of (menu item, confirm dialog, toasts, undo hints, the note); only
 * those strings and "Preview this version" say "current" or "version";
 * everything else says "release". Calm words: when something might look different, say how to go
 * back. No CDN, git, commit, revert, sha or "live"
 * (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Every release of your site, newest first. Make an earlier one current to bring its content back.",
  "releases.loadFailed": "Couldn't load your releases.",
  "releases.nothingPublished": "Nothing published yet",
  "releases.lastPublished": "Last published {when}.",
  "releases.latest": "Latest",
  "releases.actions": "Release actions",
  "releases.preview": "Preview this version",
  "releases.reapply": "Make current",
  "releases.reapplyTitle": "Make this release current?",
  "releases.reapplyBody":
    "Making it current publishes a new release with the same content as “{title}”. Changes made since will be replaced on your site.",
  "releases.reapplyUndoHint":
    "The release marked Latest stays in the list: to go back afterwards, make it current again.",
  "releases.reapplyConfirm": "Make current",
  "releases.reapplying": "Making current…",
  "releases.reapplied": "Made current. Your site will show it shortly.",
  "releases.reappliedUndoHint":
    "If something doesn't look right, make the previous release current again to go back.",
  "releases.reapplyFailed": "Couldn't make this release current.",
  "releases.alreadyShown": "Your site already has this release's content.",
  "releases.publishedMeanwhile":
    "Someone published while you were making this release current, so nothing changed. Try again.",
  "releases.reapplyOf": "Made current: {title}",
  "releases.reapplyOfDate": "Made current: release from {when}",
  "releases.sameContentAs": "Same content as the release from {when}",
  "releases.untitled": "Published changes",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
