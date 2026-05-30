import { useProjectContext } from "@decocms/mesh-sdk";
import { MemoizedMarkdown } from "../../chat/markdown.tsx";
import { CommentsAccordion } from "./comments-accordion.tsx";
import { decodeHtmlEntities } from "./decode-html-entities.ts";
import { usePrComments, type PrSummary } from "./use-pr-data.ts";

interface Props {
  pr: PrSummary;
  connectionId: string;
  owner: string;
  repo: string;
}

/**
 * Description sub-tab: PR title + body (markdown with entity decode) +
 * collapsible comments accordion.
 */
export function DescriptionTab({ pr, connectionId, owner, repo }: Props) {
  const { org } = useProjectContext();
  const commentsQuery = usePrComments({
    orgId: org.id,
    orgSlug: org.slug,
    connectionId,
    owner,
    repo,
    prNumber: pr.number,
  });

  return (
    <div className="space-y-8">
      {pr.body && (
        <div className="text-sm">
          <MemoizedMarkdown
            id={`pr-body-${pr.number}`}
            text={decodeHtmlEntities(pr.body)}
          />
        </div>
      )}
      <CommentsAccordion
        comments={commentsQuery.data ?? []}
        isLoading={commentsQuery.isLoading}
        isError={commentsQuery.isError}
      />
    </div>
  );
}
