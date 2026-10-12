import { useNavigate, useSearch } from "@tanstack/react-router";
import { HOME_MOUNT_PATH } from "@decocms/shared/organization/home-mount";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { ChatLayout, useChatLayout } from "@/components/chat-layout";
import { Page } from "@/components/page";
import { basename, libraryTrail } from "@/layouts/library/location";
import { LibraryPreviewPanel } from "@/layouts/library/preview-panel";
import { LibraryTab } from "@/layouts/main-panel-tabs/library-tab";

export default function LibraryRoute() {
  const navigate = useNavigate();
  const { preview, expanded } = useSearch({ strict: false }) as {
    preview?: string;
    expanded?: boolean;
  };
  const show = (next: { path?: string; preview?: string; expanded?: true }) =>
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(next.path !== undefined && { path: next.path }),
        preview: next.preview,
        expanded: next.expanded,
      }),
    });
  const close = () => show({});
  /** With the chat beside the page, a file beside the list would be a third
   *  panel: the file takes the page instead, and stays there until the chat
   *  closes. */
  const isMobile = useIsMobile();
  const chatBeside = useChatLayout().threadOpen && !isMobile;

  if (preview && (expanded || chatBeside)) {
    const folder = preview.slice(0, Math.max(preview.lastIndexOf("/"), 0));
    return (
      <ChatLayout.Content>
        <Page.Breadcrumbs
          after="page"
          parent={{ onSelect: close }}
          items={[
            ...libraryTrail(folder, HOME_MOUNT_PATH).map((crumb) => ({
              key: `folder:${crumb.path}`,
              label: crumb.label,
              onSelect: () => show({ path: crumb.path }),
            })),
            { key: "file", label: basename(preview) },
          ]}
        />
        <LibraryPreviewPanel
          key={preview}
          previewPath={preview}
          onClose={close}
          expand={{
            expanded: true,
            onToggle: chatBeside ? undefined : () => show({ preview }),
          }}
        />
      </ChatLayout.Content>
    );
  }

  return (
    <ChatLayout.Content
      aside={
        preview && (
          <LibraryPreviewPanel
            key={preview}
            variant="aside"
            previewPath={preview}
            onClose={close}
            expand={{
              expanded: false,
              onToggle: () => show({ preview, expanded: true }),
            }}
          />
        )
      }
    >
      {/* Beside the list: a main-panel tab would carry the org's drive into
          an agent's workspace. */}
      <LibraryTab filePreview="side" />
    </ChatLayout.Content>
  );
}
