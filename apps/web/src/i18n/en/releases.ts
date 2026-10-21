/**
 * The Releases screen of a hosted site (the `releases` route). Business-user
 * copy: "Latest" is the release your last publish made the newest; "Make
 * current" publishes a new release with an earlier one's content (the note it
 * writes says "Reapply: …"), and "Preview this version" opens an earlier
 * release in a preview. Those two menu items (and the confirm button) are the
 * only places that say "version" or "current"; everything else says
 * "release". Calm words: when something might look different, say how to go
 * back. No CDN, git, commit, revert, sha or "live"
 * (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Every release of your site, newest first. Reapply an earlier one to bring its content back.",
  "releases.loadFailed": "Couldn't load your releases.",
  "releases.nothingPublished": "Nothing published yet",
  "releases.lastPublished": "Last published {when}.",
  "releases.latest": "Latest",
  "releases.actions": "Release actions",
  "releases.preview": "Preview this version",
  "releases.reapply": "Make current",
  "releases.reapplyTitle": "Reapply this release?",
  "releases.reapplyBody":
    "This publishes a new release with the same content as “{title}”. Changes made since will be replaced on your site.",
  "releases.reapplyUndoHint":
    "If something doesn't look right afterwards, reapply the release you have now to go back.",
  "releases.reapplyConfirm": "Make current",
  "releases.reapplying": "Reapplying…",
  "releases.reapplied": "Reapplied. Your site will show it shortly.",
  "releases.reappliedUndoHint":
    "If something doesn't look right, reapply the previous release to go back.",
  "releases.reapplyFailed": "Couldn't reapply this release.",
  "releases.alreadyShown": "Your site already has this release's content.",
  "releases.publishedMeanwhile":
    "Someone published while you were reapplying, so nothing changed. Try again.",
  "releases.reapplyOf": "Reapply: {title}",
  "releases.reapplyOfDate": "Reapply: release from {when}",
  "releases.sameContentAs": "Same content as the release from {when}",
  "releases.untitled": "Published changes",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
