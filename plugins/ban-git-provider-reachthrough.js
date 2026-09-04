/**
 * Lint plugin enforcing the git-provider boundary.
 *
 * `apps/api/src/git-providers/` is one interface with one implementation per
 * provider. Everything above it speaks `RepoRef` and gets back a contract;
 * `github/` and `gitlab/` are the only places a provider's name, hosts,
 * endpoints and error prose appear. That property is what makes adding a third
 * provider a directory instead of an archaeology exercise — and it is only
 * true for as long as nobody reaches past the front door.
 *
 * Two rules, both about imports:
 *
 * 1. Code OUTSIDE the layer may not import `git-providers/github/**` or
 *    `git-providers/gitlab/**`. Import `@/git-providers` instead. A caller
 *    that genuinely needs one provider wants a capability the interface does
 *    not express yet — add it to the interface rather than reaching around it.
 * 2. One provider's directory may not import another's. A shared helper
 *    belongs in the contract both implement (this caught a real one:
 *    `gitlab/change-requests.ts` importing `summarizeChecks` from the GitHub
 *    side, which quietly made GitLab's CI summary GitHub's).
 *
 * The ALLOWLIST is deliberately tiny and both entries are provider-specific
 * BY CONSTRUCTION — there is no single flow for them to implement:
 *   - `api/routes/git-providers.ts`: a GitHub App installation and a GitLab
 *     OAuth grant are different redirect dances.
 *   - `tools/github/list-user-orgs.ts`: listing App installations has no
 *     counterpart on another provider to abstract over.
 * Do not silence this rule. Extending the allowlist is a conscious act that
 * needs a reason of that kind, not a deadline.
 *
 * Companion to `ban-cross-tree-imports.js`, `ban-web-server-imports.js` and
 * `ban-e2e-app-imports.js`.
 */

const LAYER = "git-providers";
const PROVIDERS = ["github", "gitlab"];

/** Files permitted to reach a provider directory. Suffix-matched. */
const ALLOWLIST = [
  "apps/api/src/api/routes/git-providers.ts",
  "apps/api/src/tools/github/list-user-orgs.ts",
];

/** The provider directory this file lives in, or null. */
function providerOf(filename) {
  for (const provider of PROVIDERS) {
    if (filename.includes(`/${LAYER}/${provider}/`)) return provider;
  }
  return null;
}

function inLayer(filename) {
  return filename.includes(`/${LAYER}/`) || filename.startsWith(`${LAYER}/`);
}

function isAllowed(filename) {
  return ALLOWLIST.some((allowed) => filename.endsWith(allowed));
}

// Resolve `../` / `./` segments of a relative spec against the importing file.
function resolveRelative(fromFile, spec) {
  const parts = fromFile.split("/");
  parts.pop(); // drop the filename → containing directory
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * The path a specifier names. `@/` is the API's own alias for
 * `apps/api/src/`, and is only read that way for a file inside that app —
 * elsewhere the same prefix means a different root.
 */
function resolveSpec(filename, spec) {
  if (spec.startsWith(".")) return resolveRelative(filename, spec);
  if (spec.startsWith("@/") && filename.includes("/apps/api/")) {
    return `apps/api/src/${spec.slice(2)}`;
  }
  return spec;
}

/** The provider directory a specifier reaches into, or null. */
function reaches(filename, spec) {
  const resolved = resolveSpec(filename, spec);
  const match = new RegExp(`(^|/)${LAYER}/(${PROVIDERS.join("|")})(/|$)`).exec(
    resolved,
  );
  return match ? match[2] : null;
}

const rule = {
  create(context) {
    const filename = context.filename ?? "";
    if (isAllowed(filename)) return {};
    const own = providerOf(filename);
    const outside = !inLayer(filename);
    if (!outside && own === null) return {}; // the neutral layer composes both

    const check = (node) => {
      const src = node?.source;
      if (!src || src.type !== "Literal" || typeof src.value !== "string") {
        return;
      }
      const target = reaches(filename, src.value);
      if (!target || target === own) return;

      context.report({
        node: src,
        message: outside
          ? `Git provider boundary: "${src.value}" reaches into ${LAYER}/${target}. ` +
            "Import @/git-providers instead — if the capability you need is not " +
            "on the interface, add it there rather than around it."
          : `Git provider boundary: ${own} must not import ${target}. ` +
            "A helper both providers need belongs in the contract they " +
            "implement, not in one of them.",
      });
    };

    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
    };
  },
};

const plugin = {
  meta: { name: "ban-git-provider-reachthrough" },
  rules: { "ban-git-provider-reachthrough": rule },
};

export default plugin;
