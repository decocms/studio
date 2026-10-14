/**
 * The Releases screen of a hosted site (the `releases` route). Business-user
 * copy: "Live" is the release the site itself says it shows; "Republish"
 * publishes a new release with an earlier one's content (the same words as
 * the "Republish: …" note it writes). No CDN, git, commit, revert, sha or
 * "current" (`site-editor-copy.test.ts` enforces it).
 */
export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "Every release of your site, newest first. Republish an earlier one to bring its content back.",
  "releases.loadFailed": "Couldn't load your releases.",
  "releases.nothingLive": "Nothing is live yet",
  "releases.checkedWithSite": "Your site confirmed what it shows {when}.",
  "releases.outsideStudio":
    "Your site shows a version that isn't in this list.",
  "releases.lastPublished": "Last published {when}.",
  "releases.liveHint":
    "Based on your last publish: your site hasn't reported what it shows.",
  "releases.live": "Live",
  "releases.goingLive": "Going live…",
  "releases.goingLiveHint": "Your site will show it in a minute or two.",
  "releases.published": "Published",
  "releases.notReportedHint":
    "Published. Your site hasn't confirmed it shows it yet.",
  "releases.actions": "Release actions",
  "releases.republish": "Republish",
  "releases.republishTitle": "Republish this release?",
  "releases.republishBody":
    "This publishes a new release with the same content as “{title}”. Changes made since will be replaced on your live site.",
  "releases.schemaMismatchBody":
    "This release was made for an earlier design of your site. Some parts may look different or be missing after you republish it.",
  "releases.republishAnyway": "Republish anyway",
  "releases.republishing": "Republishing…",
  "releases.republished": "Republished. Your site will show it shortly.",
  "releases.republishFailed": "Couldn't republish this release.",
  "releases.alreadyShown": "Your site already shows this release's content.",
  "releases.publishedMeanwhile":
    "Someone published while you were republishing, so nothing changed. Try again.",
  "releases.republishOf": "Republish: {title}",
  "releases.republishOfDate": "Republish of the release from {when}",
  "releases.sameContentAs": "Same content as the release from {when}",
  "releases.untitled": "Published changes",
  "releases.siteUpdate": "Site update",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
