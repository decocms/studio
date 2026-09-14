export interface BlockValueSnapshot {
  exists: boolean;
  value: unknown;
}

export interface BlockSaveRevision {
  key: string;
  revision: number;
}

interface RevisionChain {
  nextRevision: number;
  latestRevision: number;
  pending: Set<number>;
  baseline: BlockValueSnapshot;
  latestSuccessful: {
    revision: number;
    snapshot: BlockValueSnapshot;
  } | null;
}

/**
 * Tracks one optimistic mutation chain per block. Mutations may enter React
 * Query while an older scoped mutation is still running, so only the newest
 * revision may finalize the cache. If that newest write fails, its rollback is
 * the latest write that actually reached the server (or the pre-chain value),
 * never another failed optimistic snapshot.
 */
export class BlockSaveRevisionTracker {
  private readonly chains = new Map<string, RevisionChain>();

  begin(key: string, baseline: BlockValueSnapshot): BlockSaveRevision {
    let chain = this.chains.get(key);
    if (!chain) {
      chain = {
        nextRevision: 0,
        latestRevision: 0,
        pending: new Set(),
        baseline,
        latestSuccessful: null,
      };
      this.chains.set(key, chain);
    }

    const revision = ++chain.nextRevision;
    chain.latestRevision = revision;
    chain.pending.add(revision);
    return { key, revision };
  }

  isLatest(token: BlockSaveRevision): boolean {
    const chain = this.chains.get(token.key);
    return Boolean(
      chain?.pending.has(token.revision) &&
        token.revision === chain.latestRevision,
    );
  }

  recordSuccess(
    token: BlockSaveRevision,
    snapshot: BlockValueSnapshot,
  ): boolean {
    const chain = this.chains.get(token.key);
    if (!chain || !chain.pending.has(token.revision)) return false;
    if (
      !chain.latestSuccessful ||
      token.revision > chain.latestSuccessful.revision
    ) {
      chain.latestSuccessful = { revision: token.revision, snapshot };
    }
    return token.revision === chain.latestRevision;
  }

  rollbackFor(token: BlockSaveRevision): BlockValueSnapshot | null {
    const chain = this.chains.get(token.key);
    if (
      !chain ||
      !chain.pending.has(token.revision) ||
      token.revision !== chain.latestRevision
    ) {
      return null;
    }
    return chain.latestSuccessful?.snapshot ?? chain.baseline;
  }

  settle(token: BlockSaveRevision): void {
    const chain = this.chains.get(token.key);
    if (!chain) return;
    chain.pending.delete(token.revision);
    if (chain.pending.size === 0) this.chains.delete(token.key);
  }
}
