/**
 * Site editor copy for business users: saving and publishing a site. Plain
 * words only — never CDN, git, branch, commit, merge, pointer, revision or
 * sha (`site-editor-copy.test.ts` enforces it). A publish toast says your
 * site will show it shortly, never "live".
 * Developer detail (an error's own text) goes behind `siteEditor.details`.
 */
export const siteEditor = {
  "siteEditor.details": "Details",
  "siteEditor.tryAgain": "Try again",
  "siteEditor.publish.published": "Published. Your site will show it shortly.",
  "siteEditor.publish.publishedOn": "Published. {host} will show it shortly.",
  "siteEditor.publish.nothingToPublish": "Nothing to publish",
  "siteEditor.publish.everythingPublished": "Everything is already published.",
  "siteEditor.publish.savedNotPublished": "Saved, but not published yet",
  "siteEditor.publish.savedNotPublishedBody":
    "Your changes are safe. Try again to publish them.",
  "siteEditor.publish.publishedMeanwhile":
    "Someone else published while you were publishing, so nothing changed. Review your changes and publish again.",
  "siteEditor.publish.changedMeanwhile":
    "Your changes were updated while you were reviewing them. Close and reopen to see what will be published.",
  "siteEditor.publish.failed":
    "Couldn't publish. Your changes are saved. Try again in a moment.",
  "siteEditor.publish.defaultNote": "Changes by {name}",
  "siteEditor.publish.defaultNoteAnonymous": "Site update",
  "siteEditor.discard.failed": "Couldn't discard. Try again.",
  "siteEditor.discard.changedMeanwhile":
    "This changed while you were looking, so nothing was discarded. The list is up to date now.",
  "siteEditor.save.failed": "Couldn't save your change. Try again.",
  "siteEditor.save.conflict":
    "Not saved: someone else changed this at the same time. We're loading their version, so make your change again.",
  "siteEditor.save.readOnly": "Not saved: this version can't be edited.",
  "siteEditor.save.invalid":
    "Not saved: some fields aren't filled in correctly. Fix them and try again.",
  "siteEditor.save.tooLarge":
    "Not saved: this content is too large. Make it smaller and try again.",
  "siteEditor.retrying.github": "Can't reach GitHub right now. Trying again…",
  "siteEditor.retrying.sandbox":
    "Can't reach the sandbox right now. Trying again…",
  "siteEditor.siteNotOwned.title": "This site is edited from another project",
  "siteEditor.siteNotOwned.body":
    "Another project in Studio was set up with this site first, so its content is edited and published there. Open that project to change the site's content. Here you can still chat and work on the site's code.",
  "siteEditor.siteNotOwned.openProjects": "See projects",
};
