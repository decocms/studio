#!/usr/bin/env bun

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const workspaceRoots = ["apps", "packages"] as const;
const requiredSections = [
  "Overview",
  "Responsibilities",
  "Usage",
  "Architecture",
  "Development",
  "Boundaries",
  "Related documentation",
] as const;
const requiredMetadata = [
  "Workspace",
  "Kind",
  "Runtime",
  "Distribution",
] as const;
const retiredReferences = [
  "apps/mesh",
  "packages/mesh-sdk",
  "packages/std",
  "@decocms/mesh-sdk",
  "@decocms/std",
] as const;

interface Workspace {
  directory: string;
  isPrivate: boolean;
  packageName: string;
}

async function collectWorkspaces(): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];

  for (const root of workspaceRoots) {
    const entries = await readdir(join(repoRoot, root), {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const directory = join(root, entry.name);
      const manifestPath = join(repoRoot, directory, "package.json");
      let manifest: { name?: unknown; private?: unknown };

      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          name?: unknown;
          private?: unknown;
        };
      } catch (error) {
        throw new Error(`${directory} must contain a readable package.json`, {
          cause: error,
        });
      }

      if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        throw new Error(`${manifestPath} must define a package name`);
      }

      workspaces.push({
        directory,
        isPrivate: manifest.private === true,
        packageName: manifest.name,
      });
    }
  }

  return workspaces.sort((left, right) =>
    left.directory.localeCompare(right.directory),
  );
}

function localLinkTarget(rawTarget: string): string | null {
  const trimmed = rawTarget.trim();
  if (
    trimmed.length === 0 ||
    trimmed.startsWith("#") ||
    /^(?:https?:|mailto:|data:)/.test(trimmed)
  ) {
    return null;
  }

  const target = trimmed.startsWith("<")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : (trimmed.match(/^[^\s]+/)?.[0] ?? "");
  const withoutAnchor = target.split("#", 1)[0];
  if (withoutAnchor.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(withoutAnchor);
  } catch {
    return withoutAnchor;
  }
}

async function validateReadme(workspace: Workspace): Promise<string[]> {
  const errors: string[] = [];
  const readmePath = join(repoRoot, workspace.directory, "README.md");
  let source: string;

  try {
    source = await readFile(readmePath, "utf8");
  } catch {
    return [`${workspace.directory}: missing README.md`];
  }

  const h1Headings = source.match(/^# .+$/gm) ?? [];
  if (h1Headings.length !== 1 || !source.startsWith(`${h1Headings[0]}\n`)) {
    errors.push("must start with exactly one level-one heading");
  }
  if (
    workspace.directory.startsWith("packages/") &&
    h1Headings[0] !== `# ${workspace.packageName}`
  ) {
    errors.push(`package heading must be exactly "# ${workspace.packageName}"`);
  }

  const tableHeader = "| Attribute | Value |\n| --- | --- |";
  if (!source.includes(tableHeader)) {
    errors.push(
      'metadata table must start with "| Attribute | Value |" and "| --- | --- |"',
    );
  }

  let previousMetadataIndex = source.indexOf(tableHeader);
  for (const field of requiredMetadata) {
    const match = new RegExp(`^\\| ${field} \\| .+ \\|$`, "m").exec(source);
    if (match === null) {
      errors.push(`metadata table is missing the "${field}" row`);
      continue;
    }
    if (match.index < previousMetadataIndex) {
      errors.push(`metadata row "${field}" is out of order`);
    }
    previousMetadataIndex = match.index;
  }

  const workspaceRow =
    `| Workspace | \`${workspace.packageName}\` ` +
    `(\`${workspace.directory}\`) |`;
  if (!source.includes(workspaceRow)) {
    errors.push(`metadata must identify the workspace as ${workspaceRow}`);
  }
  if (workspace.directory.startsWith("packages/")) {
    const distribution = workspace.isPrivate
      ? "Private workspace package"
      : "Public npm package";
    if (!source.includes(`| Distribution | ${distribution}`)) {
      errors.push(`package distribution must start with "${distribution}"`);
    }
  }

  let previousSectionIndex = -1;
  for (const section of requiredSections) {
    const heading = `## ${section}`;
    const matches = source.match(new RegExp(`^${heading}$`, "gm")) ?? [];
    if (matches.length !== 1) {
      errors.push(`must contain exactly one "${heading}" section`);
      continue;
    }

    const sectionIndex = source.indexOf(heading);
    if (sectionIndex < previousSectionIndex) {
      errors.push(`"${heading}" is out of order`);
    }
    previousSectionIndex = sectionIndex;
  }

  for (const reference of retiredReferences) {
    if (source.includes(reference)) {
      errors.push(`contains retired reference "${reference}"`);
    }
  }

  const linkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  for (const match of source.matchAll(linkPattern)) {
    const target = localLinkTarget(match[1] ?? "");
    if (target === null) {
      continue;
    }

    const absoluteTarget = resolve(dirname(readmePath), target);
    try {
      await stat(absoluteTarget);
    } catch {
      errors.push(`local link does not exist: ${match[1]}`);
    }
  }

  return errors.map((error) => `${workspace.directory}: ${error}`);
}

const workspaces = await collectWorkspaces();
const errors = (
  await Promise.all(workspaces.map((workspace) => validateReadme(workspace)))
).flat();
const rootReadme = await readFile(join(repoRoot, "README.md"), "utf8");

for (const workspace of workspaces) {
  const link = `(./${workspace.directory}/README.md)`;
  if (!rootReadme.includes(link)) {
    errors.push(`README.md: workspace index is missing ${link}`);
  }
}

if (errors.length > 0) {
  console.error("Workspace README validation failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Validated ${workspaces.length} workspace READMEs.`);
