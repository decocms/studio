/**
 * Inline link pickers for the rich-text link control: choose another post or a
 * catalog product instead of typing a URL. Each calls `onPick(url)` with the
 * target's path/PDP so the editor links to it — the internal-linking the blog
 * needs for SEO and on-site navigation, without hunting for URLs.
 */
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loading02, SearchSm } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { KEYS } from "@/lib/query-keys";
import type { PreviewProxyRef } from "@/components/sections-editor/preview-fetch-url";
import { applyBlogPageSlug, findBlogPageSlug } from "../blog-preview-url";
import { listPostsWithMeta } from "../blog-data";
import {
  buildProductRequests,
  type ProductPickerOption,
  productOptionsFromPayload,
} from "./product-picker-source";
import { invokeLoader } from "./use-product-lookup";

/** A search box plus a scrollable result list — shared by both pickers. */
function PickerShell({
  value,
  onChange,
  placeholder,
  children,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 rounded border px-2">
        <SearchSm size={13} className="shrink-0 text-muted-foreground" />
        <input
          // oxlint-disable-next-line no-autofocus -- popover opened on explicit user action
          autoFocus
          type="text"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-7 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      <div className="max-h-56 overflow-y-auto">{children}</div>
    </div>
  );
}

/** One result row — mousedown-safe so it applies before the popover blurs. */
function ResultRow({
  label,
  sublabel,
  image,
  onPick,
}: {
  label: string;
  sublabel?: string;
  image?: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left transition-colors hover:bg-muted"
    >
      {image !== undefined && (
        <img
          src={image}
          alt=""
          className="h-7 w-7 shrink-0 rounded object-cover"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{label}</span>
        {sublabel && (
          <span className="block truncate text-xs text-muted-foreground">
            {sublabel}
          </span>
        )}
      </span>
    </button>
  );
}

/** Link to one of the site's own posts — resolves the on-site post path. */
export function PostLinkPicker({
  decofile,
  onPick,
}: {
  decofile: Record<string, unknown>;
  onPick: (url: string) => void;
}) {
  const t = useT();
  const [term, setTerm] = useState("");
  const template = findBlogPageSlug(decofile);
  const q = term.trim().toLowerCase();
  const posts = listPostsWithMeta(decofile)
    .filter(
      (p) =>
        !q ||
        p.title.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q),
    )
    .slice(0, 30);

  const pathFor = (post: (typeof posts)[number]): string | null => {
    if (!template) return null;
    return applyBlogPageSlug(template, {
      category: post.categorySlugs[0] ?? "",
      slug: post.slug,
    });
  };

  return (
    <PickerShell
      value={term}
      onChange={setTerm}
      placeholder={t("sandbox.linkPicker.searchPosts")}
    >
      {posts.length === 0 ? (
        <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">
          {t("sandbox.linkPicker.noPosts")}
        </p>
      ) : (
        posts.map((post) => {
          const path = pathFor(post);
          if (!path) return null;
          return (
            <ResultRow
              key={post.key}
              label={post.title || post.slug}
              sublabel={path}
              onPick={() => onPick(path)}
            />
          );
        })
      )}
    </PickerShell>
  );
}

/** Link to a catalog product — resolves the PDP url via the site's loader. */
export function ProductLinkPicker({
  sandboxRef,
  onPick,
}: {
  sandboxRef: PreviewProxyRef;
  onPick: (url: string) => void;
}) {
  const t = useT();
  const [term, setTerm] = useState("");
  const [debounced, setDebounced] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onSearch = (value: string) => {
    setTerm(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(value.trim()), 300);
  };

  const query = useQuery({
    queryKey: KEYS.sandboxInvoke(
      `${sandboxRef.orgSlug}/${sandboxRef.virtualMcpId}/${sandboxRef.branch}`,
      `product-link:${debounced}`,
    ),
    enabled: debounced.length > 0,
    queryFn: async () => {
      const [request] = buildProductRequests("search", debounced);
      if (!request) return [] as ProductPickerOption[];
      const data = await invokeLoader(sandboxRef, request);
      return productOptionsFromPayload(data).filter((o) => o.url);
    },
  });

  const options = query.data ?? [];

  return (
    <PickerShell
      value={term}
      onChange={onSearch}
      placeholder={t("sandbox.linkPicker.searchProducts")}
    >
      {query.isFetching ? (
        <p className="flex items-center justify-center gap-1.5 px-1.5 py-3 text-xs text-muted-foreground">
          <Loading02 size={12} className="animate-spin" />
          {t("sandbox.linkPicker.searching")}
        </p>
      ) : debounced.length === 0 ? (
        <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">
          {t("sandbox.linkPicker.typeToSearch")}
        </p>
      ) : options.length === 0 ? (
        <p className="px-1.5 py-3 text-center text-xs text-muted-foreground">
          {t("sandbox.linkPicker.noProducts")}
        </p>
      ) : (
        options.map((option) => (
          <ResultRow
            key={option.id}
            label={option.label}
            image={option.image ?? ""}
            onPick={() => option.url && onPick(option.url)}
          />
        ))
      )}
    </PickerShell>
  );
}
