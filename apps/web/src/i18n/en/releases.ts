/**
 * The Versions screen of a hosted site (the `releases` route). Business-user
 * copy: "Published" is the version the site shows; no CDN, git, commit, sha
 * or "current" (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Versions",
  "releases.subtitle":
    "Every version of your site, newest first. You can publish an earlier one to bring it back.",
  "releases.loadFailed": "Couldn't load your versions.",
  "releases.publishedAgo": "Published {when}",
  "releases.nothingPublished": "Nothing published yet",
  "releases.published": "Published",
  "releases.actions": "Version actions",
  "releases.publishVersion": "Publish this version",
  "releases.publishVersionTitle": "Publish this version?",
  "releases.publishVersionBody":
    "Your site will show this version from now on. Your next Publish replaces it with your latest changes.",
  "releases.schemaMismatchBody":
    "This version was made for an earlier design of your site. Your site keeps showing what it shows now until its design matches this version again. Publish anyway?",
  "releases.publishAnyway": "Publish anyway",
  "releases.versionLive": "This version is live.",
  "releases.publishVersionFailed": "Couldn't publish this version.",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
