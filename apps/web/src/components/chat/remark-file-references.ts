interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

const FILE_NAME = /(?<![\w/@:.+-])([\w-]+(?:\.[\w-]+)+)(?![\w/@:+-])/g;

export function hasFileName(text: string): boolean {
  return new RegExp(FILE_NAME).test(text);
}

/** Only link names confirmed by the source chat's output listing. */
export function remarkFileReferences(files: ReadonlySet<string>) {
  return (tree: MarkdownNode) => {
    function walk(node: MarkdownNode) {
      if (
        [
          "link",
          "linkReference",
          "code",
          "html",
          "image",
          "imageReference",
        ].includes(node.type)
      )
        return;
      if (!node.children) return;
      node.children = node.children.flatMap((child): MarkdownNode[] => {
        if (
          child.type === "inlineCode" &&
          child.value &&
          files.has(child.value)
        ) {
          return [
            {
              type: "link",
              url: "/app/org/output/" + child.value,
              children: [{ type: "text", value: child.value }],
            },
          ];
        }
        if (child.type !== "text" || !child.value) {
          walk(child);
          return [child];
        }
        const result: MarkdownNode[] = [];
        let start = 0;
        for (const match of child.value.matchAll(FILE_NAME)) {
          const name = match[1];
          if (!name || !files.has(name)) continue;
          result.push({
            type: "text",
            value: child.value.slice(start, match.index),
          });
          result.push({
            type: "link",
            url: "/app/org/output/" + name,
            children: [{ type: "text", value: name }],
          });
          start = match.index + name.length;
        }
        if (!start) return [child];
        result.push({ type: "text", value: child.value.slice(start) });
        return result;
      });
    }
    walk(tree);
  };
}
