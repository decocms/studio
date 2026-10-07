export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "What your site serves, and every version of main. Rolling back is temporary: the next Publish or Resync makes main live again.",
  "releases.loadFailed": "Couldn't load releases",
  "releases.serving": "Live on running sites",
  "releases.nothingPublished": "Nothing published by the CMS yet.",
  "releases.publishedAgo": "published {when}",
  "releases.rolledBackHint":
    "Rolled back: main is at {head}. The next Publish or Resync replaces this.",
  "releases.state.live": "Live",
  "releases.state.rolledBack": "Rolled back",
  "releases.state.pending": "Not published",
  "releases.revisionOffMain": "(revision no longer on main)",
  "releases.unpublishedCommits": "main has unpublished commits",
  "releases.noRecentRelease":
    "No CMS-published release in the last {count} commits",
  "releases.current": "Current",
  "releases.notPublished": "Not published by the CMS",
  "releases.actions": "Release actions",
  "releases.makeCurrent": "Make current",
  "releases.makeCurrentTitle": "Make {sha} current?",
  "releases.makeCurrentBody":
    "Running sites switch to this version within a few minutes. Git doesn't change, and the next Publish or Resync overrides it.",
  "releases.schemaMismatchBody":
    "This version was published with a different schema than main's. Sites built from main keep their current content until the schemas match again.",
  "releases.madeCurrent": "{sha} is now current",
  "releases.resync": "Resync",
  "releases.resynced": "Main is live again",
  "releases.resyncPending":
    "Main moved while resyncing; nothing changed. Try again.",
  "releases.resyncConfirmTitle": "Override the rollback?",
  "releases.resyncConfirmBody":
    "The site is rolled back to an earlier version. Resync makes main's latest version live instead.",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
