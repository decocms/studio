import type { OnMount } from "@monaco-editor/react";
import { loader } from "@monaco-editor/react";

export async function getReturnType(editor: Parameters<OnMount>[0]) {
  const model = editor.getModel();
  if (!model) {
    throw new Error("[Monaco] No model found in editor");
  }
  // Strategy: Append a helper type to the code and query its expanded type
  const originalCode = model.getValue();

  // Use a recursive Expand utility type to force TypeScript to inline all type references
  const helperCode = `
type __ExpandRecursively<T> = T extends (...args: infer A) => infer R
  ? (...args: __ExpandRecursively<A>) => __ExpandRecursively<R>
  : T extends object
  ? T extends infer O ? { [K in keyof O]: __ExpandRecursively<O[K]> } : never
  : T;
type __InferredOutput = __ExpandRecursively<Awaited<ReturnType<typeof __default>>>;
declare const __outputValue: __InferredOutput;
`;

  // Replace "export default" with a named function temporarily
  const modifiedCode =
    originalCode.replace(
      /export default (async )?function/,
      "export default $1function __default",
    ) + helperCode;

  // Set the modified code temporarily
  model.setValue(modifiedCode);

  // Find the __outputValue declaration to get its type
  const matches = model.findMatches(
    "__outputValue",
    false,
    false,
    false,
    null,
    false,
  );

  if (!matches || matches.length === 0) {
    model.setValue(originalCode);
    return null;
  }

  const match = matches[0];
  if (!match) {
    model.setValue(originalCode);
    return null;
  }

  const position = {
    lineNumber: match.range.startLineNumber,
    column: match.range.startColumn + 1,
  };

  try {
    // Get the actual Monaco instance from the loader (not the React wrapper)
    const monacoInstance = await loader.init();
    const worker =
      await monacoInstance.languages.typescript.getTypeScriptWorker();
    if (!worker) {
      model.setValue(originalCode);
      return null;
    }
    const client = await worker(model.uri);

    // Wait for TypeScript to process the modified code
    await new Promise((resolve) => setTimeout(resolve, 100));

    const offset = model.getOffsetAt(position);
    const quickInfo = await client.getQuickInfoAtPosition(
      model.uri.toString(),
      offset,
    );

    // Restore original code
    model.setValue(originalCode);

    if (quickInfo) {
      const displayString = quickInfo.displayParts
        .map((part: { text: string }) => part.text)
        .join("");

      // Clean up the display string - remove "const __outputValue: " prefix
      const typeOnly = displayString.replace(/^const __outputValue:\s*/, "");

      // Convert to JSON Schema
      const jsonSchema = tsTypeToJsonSchema(typeOnly);

      return jsonSchema;
    } else {
      return null;
    }
  } catch (error) {
    model.setValue(originalCode);
    console.error("Error getting return type:", error);
    return null;
  }
}

function tsTypeToJsonSchema(typeStr: string): object {
  typeStr = typeStr.trim();

  // Handle primitives
  if (typeStr === "string") return { type: "string" };
  if (typeStr === "number") return { type: "number" };
  if (typeStr === "boolean") return { type: "boolean" };
  if (typeStr === "null") return { type: "null" };
  if (typeStr === "undefined") return { type: "null" };
  if (typeStr === "unknown" || typeStr === "any") return {};
  if (typeStr === "never") return { not: {} };

  // Handle arrays: T[] or Array<T>
  if (typeStr.endsWith("[]")) {
    const itemType = typeStr.slice(0, -2);
    return { type: "array", items: tsTypeToJsonSchema(itemType) };
  }
  const arrayMatch = typeStr.match(/^Array<(.+)>$/);
  if (arrayMatch && arrayMatch[1]) {
    return { type: "array", items: tsTypeToJsonSchema(arrayMatch[1]) };
  }

  // Handle Record<K, V>
  const recordMatch = typeStr.match(/^Record<(.+),\s*(.+)>$/);
  if (recordMatch && recordMatch[2]) {
    return {
      type: "object",
      additionalProperties: tsTypeToJsonSchema(recordMatch[2].trim()),
    };
  }

  // Handle union types: A | B | C
  // Check if there's a | at depth 0 (not inside braces/brackets/parentheses)
  if (typeStr.includes("|")) {
    const parts = splitUnion(typeStr);
    // Only treat as union if splitUnion actually split it into multiple parts
    if (parts.length > 1) {
      // Check if it's a string literal union
      const allStringLiterals = parts.every((p) => /^["']/.test(p.trim()));
      if (allStringLiterals) {
        return {
          type: "string",
          enum: parts.map((p) => p.trim().replace(/^["']|["']$/g, "")),
        };
      }
      return { anyOf: parts.map((p) => tsTypeToJsonSchema(p.trim())) };
    }
  }

  // Handle string/number literals
  if (/^["'].*["']$/.test(typeStr)) {
    return { type: "string", const: typeStr.slice(1, -1) };
  }
  if (/^-?\d+(\.\d+)?$/.test(typeStr)) {
    return { type: "number", const: parseFloat(typeStr) };
  }

  // Handle object types: { prop: type; ... }
  if (typeStr.startsWith("{") && typeStr.endsWith("}")) {
    return parseObjectType(typeStr);
  }

  // Fallback for complex types
  return { description: `TypeScript type: ${typeStr}` };
}

// Split union types while respecting nested braces
function splitUnion(typeStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < typeStr.length; i++) {
    const char = typeStr[i];
    if (char === "{" || char === "<" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ">" || char === ")" || char === "]")
      depth--;
    else if (char === "|" && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

// Parse object type: { prop: type; prop2?: type2; ... }
function parseObjectType(typeStr: string): object {
  // Remove outer braces
  const inner = typeStr.slice(1, -1).trim();
  if (!inner) return { type: "object", properties: {} };

  const properties: Record<string, object> = {};
  const required: string[] = [];

  // Parse properties - handle nested objects by tracking brace depth
  let depth = 0;
  let currentProp = "";

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === "{" || char === "<" || char === "(" || char === "[") depth++;
    else if (char === "}" || char === ">" || char === ")" || char === "]")
      depth--;
    else if (char === ";" && depth === 0) {
      if (currentProp.trim()) {
        parseSingleProperty(currentProp.trim(), properties, required);
      }
      currentProp = "";
      continue;
    }
    currentProp += char;
  }
  // Handle last property (may not end with ;)
  if (currentProp.trim()) {
    parseSingleProperty(currentProp.trim(), properties, required);
  }

  const schema: Record<string, unknown> = {
    type: "object",
    properties,
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function parseSingleProperty(
  propStr: string,
  properties: Record<string, object>,
  required: string[],
) {
  // Match: propName?: type or propName: type
  const match = propStr.match(/^(\w+)(\?)?:\s*(.+)$/s);
  if (match) {
    const propName = match[1];
    const optional = match[2];
    const propType = match[3];
    if (propName && propType) {
      properties[propName] = tsTypeToJsonSchema(propType.trim());
      if (!optional) {
        required.push(propName);
      }
    }
  }
}
