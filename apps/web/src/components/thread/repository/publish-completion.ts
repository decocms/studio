/**
 * What the CMS header does once a Publish succeeded. v7 (and a v8 sandbox):
 * land on a fresh editable draft and discard the merged one (switcher entry
 * and branch), as on main. A hosted v8 editor stays on its draft (PO
 * decision): Publish emptied it in place, so the branch, the switcher entry
 * and the preview's `__draft` slug stay the same.
 */
export async function settleAfterPublish(params: {
  hosted: boolean;
  /** The branch that was published. */
  branch: string | null | undefined;
  baseBranch: string;
  nextBranch: () => string;
  setCurrentTaskBranch: (branch: string) => Promise<unknown> | unknown;
  deleteRelease: (branch: string) => Promise<unknown> | unknown;
}): Promise<void> {
  if (params.hosted) return;
  const published = params.branch;
  await params.setCurrentTaskBranch(params.nextBranch());
  if (published && published !== params.baseBranch) {
    await params.deleteRelease(published);
  }
}
