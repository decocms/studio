import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "@babel/core";
import reactCompiler from "babel-plugin-react-compiler";

/**
 * React Compiler skips, without a build error, any component it cannot
 * compile. These components re-render on every keystroke in a block form, so
 * losing memoization in one of them re-renders the whole open form per key.
 */
const KEYSTROKE_PATH: Record<string, string[]> = {
  "../sandbox/content/runnable-block-editor.tsx": ["RunnableBlockEditor"],
  "../sandbox/blocks/global-loader-editor.tsx": ["GlobalLoaderEditor"],
  "schema-form.tsx": ["RootSchemaForm", "SchemaFormBody"],
  "fields/array-field.tsx": ["ArrayField"],
  "fields/object-field.tsx": ["ObjectField"],
  "fields/string-field.tsx": ["StringField"],
  "fields/multivariate-field-wrapper.tsx": ["MultivariateFieldWrapper"],
  "fields/named-rule-block-field.tsx": ["NamedRuleBlockField"],
  "variant-rule-editor.tsx": ["VariantRuleEditor"],
  "matcher-picker.tsx": ["MatcherPicker"],
};

function compiledComponents(file: string): Set<string> {
  const compiled = new Set<string>();
  transformSync(readFileSync(file, "utf8"), {
    filename: file,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [
      [
        reactCompiler,
        {
          logger: {
            logEvent(_file: string | null, event: { kind: string }) {
              if (event.kind !== "CompileSuccess") return;
              const { fnName } = event as { fnName?: string | null };
              if (fnName) compiled.add(fnName);
            },
          },
        },
      ],
    ],
  });
  return compiled;
}

describe("React Compiler on the block form keystroke path", () => {
  for (const [relative, components] of Object.entries(KEYSTROKE_PATH)) {
    test(relative, () => {
      const compiled = compiledComponents(join(import.meta.dir, relative));
      for (const name of components) {
        expect({ name, compiled: compiled.has(name) }).toEqual({
          name,
          compiled: true,
        });
      }
    });
  }
});
