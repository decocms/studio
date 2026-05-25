export type TreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: TreeNode[];
};

export type FlatNode = {
  node: TreeNode;
  depth: number;
};

export type FileBuffer = {
  savedContent: string;
  editorValue: string;
  loaded: boolean;
};
