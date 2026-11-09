import { Card } from "@decocms/ui/components/card.tsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Mail01,
  MessageChatCircle,
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
      <Card size="flush" className="my-4 gap-0">
        <Accordion type="single" collapsible>
          <AccordionItem value="testing" className="py-0">
            <AccordionTrigger className="px-4 py-3">
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
    <section className="surface my-4 overflow-hidden" aria-label={brand.name}>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-3">
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
      <div className="p-4">
        <div className="mb-3 flex items-center gap-2">
          {data.author.avatarUrl ? (
            <img
              src={data.author.avatarUrl}
              alt=""
              className="size-8 rounded-full object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="flex size-8 items-center justify-center rounded-full bg-muted">
              <MessageChatCircle className="size-4" />
            </span>
          )}
          <span className="text-sm font-medium">{data.author.name}</span>
          {data.sentAt && (
            <time
              dateTime={data.sentAt}
              className="ml-auto text-xs text-muted-foreground"
            >
              {new Date(data.sentAt).toLocaleString()}
            </time>
          )}
        </div>
        <div className="min-w-0 break-words text-sm">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents}
            skipHtml
          >
            {data.body}
          </ReactMarkdown>
        </div>
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
    </section>
  );
}
