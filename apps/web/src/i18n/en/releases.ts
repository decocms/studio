export const releases = {
  "releases.title": "Releases",
  "releases.subtitle":
    "What your site serves, and every version of main. Rolling back is temporary: the next Publish or Resync makes main live again.",
  "releases.loadFailed": "Couldn't load releases",
  "releases.serving": "On running sites",
  "releases.nothingPublished": "Nothing published by the CMS yet.",
  "releases.publishedAgo": "published {when}",
  "releases.rolledBackHint":
    "Rolled back: main is at {head}. The next Publish or Resync replaces this.",
  "releases.state.live": "Live",
  "releases.state.rolledBack": "Rolled back",
  "releases.state.failed": "CDN update failed",
  "releases.state.notLive": "Not live",
  "releases.failedHint":
    "Main's newest release isn't live on the CDN yet. Resync to make it live.",
  "releases.merged": "Merged",
  "releases.failed": "Failed",
  "releases.resyncMainMoved":
    "Main moved while resyncing, so the CDN wasn't updated. Resync again.",
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
  "releases.resyncConfirmTitle": "Override the rollback?",
  "releases.resyncConfirmBody":
    "The site is rolled back to an earlier version. Resync makes main's latest version live instead.",
  "releases.loadMore": "Load more",
  "releases.cancel": "Cancel",
};
