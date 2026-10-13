/**
 * The Releases screen of a hosted site (the `releases` route). Business-user
 * copy: "Published" is the release the site shows; no CDN, git, commit, sha
 * or "current" (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Every release of your site, newest first. You can publish an earlier one to bring it back.",
  "releases.loadFailed": "Couldn't load your releases.",
  "releases.publishedAgo": "Published {when}",
  "releases.nothingPublished": "Nothing published yet",
  "releases.published": "Published",
  "releases.actions": "Release actions",
  "releases.publishVersion": "Publish this release",
  "releases.publishVersionTitle": "Publish this release?",
  "releases.publishVersionBody":
    "Your site will show this release from now on. Your next Publish replaces it with your latest changes.",
  "releases.schemaMismatchBody":
    "This release was made for an earlier design of your site. Your site keeps showing what it shows now until its design matches this release again. Publish anyway?",
  "releases.publishAnyway": "Publish anyway",
  "releases.versionLive": "This release is live.",
  "releases.publishVersionFailed": "Couldn't publish this release.",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
