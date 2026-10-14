/**
 * The Releases screen of a hosted site (the `releases` route). Business-user
 * copy: "Latest" is the version your last publish made the newest; "Reapply
 * version" publishes a new version with an earlier one's content (the same
 * words as the "Reapply: …" note it writes). Calm words: when something
 * might look different, say how to go back. No CDN, git, commit, revert, sha,
 * "current" or "live" (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Every version of your site, newest first. Reapply an earlier one to bring its content back.",
  "releases.loadFailed": "Couldn't load your releases.",
  "releases.nothingPublished": "Nothing published yet",
  "releases.lastPublished": "Last published {when}.",
  "releases.latest": "Latest",
  "releases.actions": "Version actions",
  "releases.reapply": "Reapply version",
  "releases.reapplyTitle": "Reapply this version?",
  "releases.reapplyBody":
    "This publishes a new version with the same content as “{title}”. Changes made since will be replaced on your site.",
  "releases.reapplyUndoHint":
    "If something doesn't look right afterwards, reapply the version you have now to go back.",
  "releases.reapplyConfirm": "Reapply",
  "releases.reapplying": "Reapplying…",
  "releases.reapplied": "Reapplied. Your site will show it shortly.",
  "releases.reappliedUndoHint":
    "If something doesn't look right, reapply the previous version to go back.",
  "releases.reapplyFailed": "Couldn't reapply this version.",
  "releases.alreadyShown": "Your site already has this version's content.",
  "releases.publishedMeanwhile":
    "Someone published while you were reapplying, so nothing changed. Try again.",
  "releases.reapplyOf": "Reapply: {title}",
  "releases.reapplyOfDate": "Reapply: version from {when}",
  "releases.sameContentAs": "Same content as the version from {when}",
  "releases.untitled": "Published changes",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
