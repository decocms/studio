/**
 * Lint plugin to ban any access to `.current` (read or write) during the
 * render body of a component or hook.
 *
 * Refs are escape hatches for imperative code. Reading or writing `.current`
 * synchronously in a component or hook body produces subtle bugs because the
 * render does not re-run when `.current` changes. All `.current` access must
 * happen inside a callback, event handler, or effect.
 *
 * Detection — TWO-LEVEL walk:
 *  1. The accessed property is `current` — either dot access (`ref.current`)
 *     or computed access (`ref["current"]`).
 *  2. Walk up from the MemberExpression to find the FIRST function ancestor
 *     (F1). If none exists, the access is at module scope → DO NOT FLAG.
 *  3. Continue walking up from F1's parent to find a SECOND function ancestor
 *     (F2).
 *  4. If F2 exists, F1 is a callback nested inside a component/hook → DO NOT
 *     FLAG (the access is inside a callback, handler, or effect).
 *  5. If F2 does not exist, F1 is the outermost enclosing function (the
 *     component or hook itself) → FLAG.
 *
 * The syntactic form of F1 (FunctionDeclaration, FunctionExpression,
 * ArrowFunctionExpression, named or anonymous) is irrelevant. Only the
 * nesting depth matters.
 *
 * This single pattern catches reads, writes, compound assignments, update
 * expressions, and nested-property mutation (`ref.current.foo = X` — the
 * inner `ref.current` MemberExpression is itself flagged).
 */

const MESSAGE =
  "Accessing .current during render is not allowed. Refs are escape hatches for imperative code — reading or writing them in the component body causes subtle bugs because the render does not re-run when .current changes. Move this access into an event handler, callback, or useState.";

function isCurrentProperty(node) {
  if (node.type !== "MemberExpression") return false;
  if (node.computed) {
    return (
      node.property.type === "Literal" && node.property.value === "current"
    );
  }
  return (
    node.property.type === "Identifier" && node.property.name === "current"
  );
}

function isFunctionNode(node) {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/**
 * Walk up from `startNode.parent`, returning the first ancestor that
 * satisfies `isFunctionNode`, or `null` if the root is reached first.
 */
function findFirstFunctionAncestor(startNode) {
  let current = startNode.parent;
  while (current) {
    if (isFunctionNode(current)) return current;
    current = current.parent;
  }
  return null;
}

const noRefCurrentInRenderRule = {
  create(context) {
    return {
      MemberExpression(node) {
        if (!isCurrentProperty(node)) return;

        // Step 1: find F1 — the innermost enclosing function.
        const f1 = findFirstFunctionAncestor(node);

        // Step 2: no enclosing function → module scope → do not flag.
        if (f1 === null) return;

        // Step 3: find F2 — the next function ancestor above F1.
        const f2 = findFirstFunctionAncestor(f1);

        // Step 4: F2 exists → F1 is a callback nested inside a component/hook → do not flag.
        // Step 5: F2 does not exist → F1 is the outermost function (the component/hook) → flag.
        if (f2 === null) {
          context.report({ node, message: MESSAGE });
        }
      },
    };
  },
};

const plugin = {
  meta: {
    name: "ban-ref-current-assignment",
  },
  rules: {
    "ban-ref-current-assignment": noRefCurrentInRenderRule,
  },
};

export default plugin;
