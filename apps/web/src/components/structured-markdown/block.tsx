import { Avatar } from "@decocms/ui/components/avatar.tsx";
import "./external-message.css";
import { Card } from "@decocms/ui/components/card.tsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Mail01,
  LinkExternal01,
  ClipboardCheck,
  Globe01,
  GitPullRequest,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@decocms/ui/components/accordion.tsx";
import { markdownComponents } from "@decocms/ui/components/markdown.tsx";
import { useT } from "@/i18n/use-t";
import type { StructuredBlock } from "./schema";

const sources = {
  gchat: {
    name: "Google Chat",
    icon: "https://www.gstatic.com/images/branding/productlogos/chat_2026/v2/web/192px.svg",
  },
  whatsapp: {
    name: "WhatsApp",
    icon: "https://cdn.simpleicons.org/whatsapp/25D366",
  },
  slack: {
    name: "Slack",
    icon: "https://a.slack-edge.com/80588/marketing/img/meta/favicon-32.png",
  },
  email: { name: "Email", icon: null },
};

export function StructuredMarkdownBlock({ block }: { block: StructuredBlock }) {
  const t = useT();
  if (block.kind === "testing") {
    const { data } = block;
    return (
      <Card
        size="flush"
        className="my-4 gap-0 overflow-hidden focus-within-ring"
      >
        <Accordion type="single" collapsible>
          <AccordionItem value="testing" className="py-0">
            <AccordionTrigger className="rounded-none px-4 py-3 focus-visible:outline-none">
              <span className="flex min-w-0 items-center gap-2">
                <ClipboardCheck className="size-4 shrink-0 text-muted-foreground" />
                <span>{data.title ?? t("structuredMarkdown.testing")}</span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="border-t px-4 pt-4 pb-4 text-foreground">
              <div className="mb-4 flex flex-wrap gap-2">
                {data.previewUrl && (
                  <Button asChild variant="secondary" size="sm">
                    <a
                      href={data.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Globe01 />
                      {t("structuredMarkdown.preview")}
                      <LinkExternal01 />
                    </a>
                  </Button>
                )}
                {data.pullRequest && (
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={data.pullRequest.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="max-w-full"
                    >
                      <GitPullRequest />
                      <span className="truncate" title={data.pullRequest.title}>
                        {t("structuredMarkdown.pullRequest")}
                      </span>
                      <LinkExternal01 />
                    </a>
                  </Button>
                )}
              </div>
              {data.note && (
                <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
                  {data.note}
                </p>
              )}
              <ol className="list-decimal space-y-4 pl-5 text-sm leading-relaxed marker:text-muted-foreground">
                {data.steps.map((step, index) => (
                  <li key={index}>
                    <p className="whitespace-pre-wrap">{step.action}</p>
                    {step.expected && (
                      <p className="mt-1 whitespace-pre-wrap text-muted-foreground">
                        {t("structuredMarkdown.expected")} {step.expected}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>
    );
  }
  const { data, source } = block;
  const brand = sources[source];
  return (
    <section
      className="external-message my-4"
      data-source={source}
      aria-label={brand.name}
    >
      <div className="external-message-origin">
        {brand.icon ? (
          <img
            src={brand.icon}
            alt=""
            className="size-5 object-contain"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <Mail01 className="size-5" />
        )}
        <span className="text-xs font-medium">{brand.name}</span>
        {data.channel && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {data.channel}
          </span>
        )}
        {data.url && (
          <a
            href={data.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs hover:underline"
          >
            {t("structuredMarkdown.source")}
            <LinkExternal01 className="size-3" />
          </a>
        )}
      </div>
      <div className="external-message-content">
        <Avatar
          url={data.author.avatarUrl}
          fallback={data.author.name}
          shape={source === "slack" ? "square" : "circle"}
          size="sm"
          className="external-message-avatar"
        />
        <div className="external-message-envelope">
          <div className="external-message-author">
            <span className="text-sm font-medium">{data.author.name}</span>
            {data.sentAt && (
              <time dateTime={data.sentAt} className="external-message-time">
                {new Date(data.sentAt).toLocaleString()}
              </time>
            )}
          </div>
          <div className="external-message-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
              skipHtml
            >
              {data.body}
            </ReactMarkdown>
            {data.attachments?.map((attachment, index) => (
              <a
                key={index}
                href={attachment.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 block text-sm underline"
              >
                {attachment.kind === "image" && (
                  <img
                    src={attachment.url}
                    alt={attachment.name}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="mb-1 max-h-64 max-w-full rounded-lg object-contain"
                  />
                )}
                {attachment.name}
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
