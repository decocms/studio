/**
 * The Releases screen of a hosted site (the `releases` route). Business-user
 * copy: "Live" is the release the site shows; going live with an earlier
 * release is not a Publish (it was published already). No CDN, git, commit,
 * sha or "current" (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Every release of your site, newest first. You can make an earlier one live again.",
  "releases.loadFailed": "Couldn't load your releases.",
  "releases.wentLiveAgo": "Went live {when}",
  "releases.nothingLive": "Nothing is live yet",
  "releases.live": "Live",
  "releases.actions": "Release actions",
  "releases.goLive": "Go live",
  "releases.goLiveTitle": "Go live with this release?",
  "releases.goLiveBody":
    "Your site will show this release from now on. Your next Publish replaces it with your latest changes.",
  "releases.schemaMismatchBody":
    "This release was made for an earlier design of your site. Your site keeps showing what it shows now until its design matches this release again. Go live anyway?",
  "releases.goLiveAnyway": "Go live anyway",
  "releases.goingLive": "Going live…",
  "releases.versionLive": "This release is live.",
  "releases.goLiveFailed": "Couldn't go live with this release.",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
