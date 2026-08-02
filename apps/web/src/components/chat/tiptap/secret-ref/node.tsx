import { secretRef } from "@/utils/secret-detect";
import { cn } from "@deco/ui/lib/utils.ts";
import { Node } from "@tiptap/core";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
} from "@tiptap/react";
import { Lock01 } from "@untitledui/icons";

export interface SecretRefAttrs {
  /** Vault secret name — what `{{secret:name}}` resolves against. */
  name: string;
  /** Vault secret id (`sec_…`), when known at insertion time. */
  secretId: string | null;
}

function SecretRefNodeView(props: NodeViewProps) {
  const { node, selected, view } = props;
  const { name } = node.attrs as SecretRefAttrs;
  const isSelected = selected && view.editable;

  return (
    <NodeViewWrapper
      title="Stored in the vault — resolved at use, never shown"
      className={cn(
        "mx-0.5 px-1.5 py-0.5 rounded-md",
        "inline-flex items-center gap-1 align-baseline",
        "select-none cursor-default",
        "font-mono text-xs",
        "border border-success/30 bg-success/10 text-success",
        isSelected && "outline-2 outline-blue-300 outline-offset-0",
      )}
    >
      <Lock01 className="size-3" />
      {name}
    </NodeViewWrapper>
  );
}

/**
 * Inline chip for a vaulted secret reference. Serializes to
 * `{{secret:name}}` on the wire (see derive-parts.ts) so the raw value never
 * enters the message text — agents resolve it from the vault at point of use.
 */
export const SecretRefNode = Node.create({
  name: "secretRef",

  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      name: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-name") || null,
        renderHTML: (attributes) => {
          if (!attributes.name) return {};
          return { "data-name": attributes.name };
        },
      },
      secretId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-secret-id") || null,
        renderHTML: (attributes) => {
          if (!attributes.secretId) return {};
          return { "data-secret-id": attributes.secretId };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-type="secret-ref"]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs: Record<string, string> = {
      "data-type": "secret-ref",
    };

    if (node.attrs.name) {
      attrs["data-name"] = node.attrs.name;
    }
    if (node.attrs.secretId) {
      attrs["data-secret-id"] = node.attrs.secretId;
    }

    return ["span", { ...HTMLAttributes, ...attrs }];
  },

  renderText({ node }) {
    return secretRef(node.attrs.name ?? "");
  },

  addNodeView() {
    return ReactNodeViewRenderer(SecretRefNodeView);
  },
});
