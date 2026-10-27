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
  "siteEditor.save.keptChanging":
    "Not saved: this kept changing while you saved. The latest version is shown now, so check it and make your change again.",
  "siteEditor.save.draftUnread":
    "Not saved yet: we couldn't reach your draft just now. Your change is still here. Check your connection, then edit again to save it.",
  "siteEditor.save.invalid":
    "Not saved: some fields aren't filled in correctly. Fix them and try again.",
  "siteEditor.save.tooLarge":
    "Not saved: this content is too large. Make it smaller and try again.",
  "siteEditor.retrying.github": "Can't reach GitHub right now. Trying again…",
  "siteEditor.retrying.sandbox":
    "Can't reach the sandbox right now. Trying again…",
  "siteEditor.contentTypes.changesInDraft": "Changes in draft",
  "siteEditor.contentTypes.searchContent": "Search content",
  "siteEditor.contentTypes.group.site": "Site",
  "siteEditor.contentTypes.group.everywhere": "Everywhere",
  "siteEditor.contentTypes.group.content": "Content",
  "siteEditor.contentTypes.pages": "Pages",
  "siteEditor.contentTypes.redirects": "Redirects",
  "siteEditor.contentTypes.settings": "Settings",
  "siteEditor.contentTypes.seo": "SEO",
  "siteEditor.contentTypes.showAll": "Show all {count}",
  "siteEditor.contentTypes.showFewer": "Show fewer",
  "siteEditor.contentTypes.search": "Search {type}",
  "siteEditor.contentTypes.filter": "Filter",
  "siteEditor.contentTypes.filter.all": "All {count}",
  "siteEditor.contentTypes.filter.changed": "Changed {count}",
  "siteEditor.contentTypes.new.page": "New page",
  "siteEditor.contentTypes.new.redirect": "New redirect",
  "siteEditor.contentTypes.new.other": "New {type}",
  "siteEditor.contentTypes.column.name": "Name",
  "siteEditor.contentTypes.column.path": "Path",
  "siteEditor.contentTypes.column.sections": "Sections",
  "siteEditor.contentTypes.column.status": "Status",
  "siteEditor.contentTypes.column.from": "From",
  "siteEditor.contentTypes.column.to": "To",
  "siteEditor.contentTypes.column.kind": "Kind",
  "siteEditor.contentTypes.column.type": "Type",
  "siteEditor.contentTypes.kind.temporary": "Temporary",
  "siteEditor.contentTypes.kind.permanent": "Permanent",
  "siteEditor.contentTypes.status.published": "Published",
  "siteEditor.contentTypes.status.changed": "Changed in draft",
  "siteEditor.contentTypes.status.new": "New in draft",
  "siteEditor.contentTypes.status.deleted": "Deleted in draft",
  "siteEditor.contentTypes.restore": "Restore",
  "siteEditor.contentTypes.restored": 'Restored "{name}"',
  "siteEditor.contentTypes.back": "Back to {type}",
  "siteEditor.contentTypes.empty": "Nothing here yet.",
  "siteEditor.contentTypes.noMatch": "Nothing matches your search.",
  "siteEditor.contentTypes.noChanges":
    "No changes in your draft. Everything here is published.",
  "siteEditor.contentTypes.status.checking": "Checking…",
  "siteEditor.contentTypes.searchRedirects": "Find an address",
  "siteEditor.contentTypes.filter.otherPaths": "Other {count}",
  "siteEditor.contentTypes.folded": "{count} more, all to the same page",
  "siteEditor.contentTypes.noChangedHere":
    "Nothing changed here. Everything here is published.",
  "siteEditor.siteNotOwned.title": "This site is edited from another project",
  "siteEditor.siteNotOwned.body":
    "Another project in Studio was set up with this site first, so its content is edited and published there. Open that project to change the site's content. Here you can still chat and work on the site's code.",
  "siteEditor.siteNotOwned.openProjects": "See projects",
};
