/**
 * The blog's block mapping, shared by the editor and the generation tools.
 *
 * Two transformations live here and nowhere else: a site's manifest and
 * decofile into the block schemas a draft must obey, and a draft back into the
 * decofile blocks that site renders. Both were in `apps/web` alone, which is
 * why driving the pipeline from anywhere else needed a script with a
 * filesystem. A tool cannot import from the web app; it can import from here.
 *
 * Layered bottom-up — `fields` knows nothing, `generation` knows everything.
 * Keep it that way: a cycle here is a cycle in the editor's render path.
 */

export {
  asRecord,
  authorEmailOf,
  type BrandRule,
  categorySlugOf,
  missingCategoryFields,
  type MissingFieldKey,
  missingPostFields,
  newPostId,
  normalizeTitleKey,
  randomHex,
  str,
  toArray,
} from "./fields";
export {
  appManifestResolveTypeAliases,
  type BlockSchemaMetadata,
  type LiveMeta,
  lookupManifestBlockSchema,
  parseLegacyAppResolveType,
  parseSiteAppResolveType,
  type RawSchema,
  resolveBlockSchemaMetadata,
  toBase64,
} from "./live-meta";
export {
  readProductListIds,
  writeProductListIds,
} from "./product-loader";
export {
  BLOG_KINDS,
  BLOG_SINGULAR,
  type BlogEntry,
  type BlogKind,
  buildBlogBlock,
  EMPTY_PAYLOAD,
  getBlogPayload,
  isBlogKind,
  listBlogPayloads,
  RESOLVE_TYPE_FOR_KIND,
  scanBlogEntries,
  WRAPPER_KEY,
} from "./decofile-scan";
export {
  type AuthorRef,
  type CategoryRef,
  DEFAULT_SCHEDULE_HOUR,
  defaultScheduledDatetime,
  isPlanningPostKey,
  listAuthorRefs,
  livePostKey,
  PLANNING_POST_KEY_PREFIX,
  type PlanningMeta,
  planningPostKey,
  postLinkTargets,
  POST_STATUSES,
  postIdOfKey,
  type PostStatus,
  postStatus,
  setPostStatus,
} from "./post-meta";
export {
  blockComponentName,
  type BlogBlockDiscoveryOptions,
  type BlogBlockSource,
  type BlogBlockType,
  blogBlockTypeFor,
  discoverBlogBlockTypes,
  isBlogPostBlockResolveType,
} from "./block-discovery";
export {
  rawBlockSchema,
  reconciledSchema,
} from "./block-schema";
export {
  citedSections,
  FORMATS_BLOCK_KEY,
  type MentionableSection,
  mentionableSections,
} from "./formats";
export {
  blockExample,
  blocksForFormat,
  buildGeneratedPostPayload,
  buildPostSections,
  type DraftSection,
  type GeneratedDraft,
  type GenerationBlock,
  KNOWN_BLOG_BLOCK_EXAMPLES,
  maskSlugInput,
  productSlotOf,
  sectionResolveTypes,
  slugifyTitle,
  uniqueCategorySlug,
  uniquePostSlug,
  uniqueSlug,
} from "./generation";
export {
  applyLinksToBlocks,
  applyLinkToBlocks,
  postBodyText,
} from "./link-enrich";
export { referencePhotos } from "./reference-photos";
