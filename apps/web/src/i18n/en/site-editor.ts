/**
 * Site editor copy for business users: saving and publishing a site. Plain
 * words only — never CDN, git, branch, commit, merge, pointer, revision or
 * sha (`site-editor-copy.test.ts` enforces it). "Published" means live.
 * Developer detail (an error's own text) goes behind `siteEditor.details`.
 */
export const siteEditor = {
  "siteEditor.details": "Details",
  "siteEditor.save.failed": "Couldn't save your change. Try again.",
  "siteEditor.save.conflict":
    "Not saved: someone else changed this at the same time. We're loading their version, so make your change again.",
  "siteEditor.save.readOnly": "Not saved: this version can't be edited.",
  "siteEditor.save.invalid":
    "Not saved: some fields aren't filled in correctly. Fix them and try again.",
  "siteEditor.save.tooLarge":
    "Not saved: this content is too large. Make it smaller and try again.",
};
