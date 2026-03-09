// ingest-docs-pinecone.ts
// Upload files from DOCS_DIR directly to a Pinecone Assistant.
// Pinecone Assistant handles chunking and embedding automatically.
//
// ENV required:
//   PINECONE_API_KEY
//   PINECONE_ASSISTANT_NAME
// Optional ENV:
//   DOCS_DIR=docs
//   EXTENSIONS=.md,.txt,.pdf,.docx,.json (Pinecone Assistant supported types)
//   MAX_FILE_MB=10
//   DELETE_ALL=false
//   UPLOAD_DELAY_MS=500 (delay between uploads to avoid rate limits)
//   MAX_RETRIES=3
//   CONVERT_MDX=true (convert .mdx files to .md before upload)
//
// Execution:
//   npx tsx -r dotenv/config scripts/ingest-docs-pinecone.ts

import { Pinecone } from "@pinecone-database/pinecone";
import fg from "fast-glob";
import fs from "node:fs/promises";
import path from "node:path";


const PINECONE_API_KEY = process.env.PINECONE_API_KEY!;
const PINECONE_ASSISTANT_NAME = process.env.PINECONE_ASSISTANT_NAME!;

if (!PINECONE_API_KEY) throw new Error("Define PINECONE_API_KEY");
if (!PINECONE_ASSISTANT_NAME) throw new Error("Define PINECONE_ASSISTANT_NAME (assistant name)");

const DOCS_DIR = process.env.DOCS_DIR || "docs";
const EXTENSIONS = (process.env.EXTENSIONS || ".md,.txt,.pdf,.docx,.json")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || "10");
const DELETE_ALL = String(process.env.DELETE_ALL || "false").toLowerCase() === "true";
const UPLOAD_DELAY_MS = Number(process.env.UPLOAD_DELAY_MS || "2000");
const MAX_RETRIES = Number(process.env.MAX_RETRIES || "3");
const CONVERT_MDX = String(process.env.CONVERT_MDX || "true").toLowerCase() === "true";

const bytesLimit = MAX_FILE_MB * 1024 * 1024;

const SEARCH_EXTENSIONS = CONVERT_MDX
  ? [...EXTENSIONS, ".mdx"]
  : EXTENSIONS;

function shouldKeep(file: string): boolean {
  const ext = path.extname(file).toLowerCase();
  return SEARCH_EXTENSIONS.includes(ext);
}

async function checkFileSize(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (stat.size > bytesLimit) {
      console.warn(`Skip due to size (${(stat.size / 1024 / 1024).toFixed(2)}MB): ${file}`);
      return false;
    }
    if (stat.size === 0) {
      console.warn(`Skip empty file: ${file}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadWithRetry(
  assistant: any,
  file: string,
  normalizedPath: string,
  retries = MAX_RETRIES
): Promise<boolean> {
  const isMdx = file.toLowerCase().endsWith(".mdx");
  let uploadPath = file;
  let tempFile: string | null = null;

  if (isMdx && CONVERT_MDX) {
    tempFile = file.replace(/\.mdx$/i, ".md");
    try {
      await fs.copyFile(file, tempFile);
      uploadPath = tempFile;
    } catch (error) {
      console.error(`❌ Error creating temporary copy of ${normalizedPath}:`, error);
      return false;
    }
  }

  try {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await assistant.uploadFile({
          path: uploadPath,
          metadata: {
            source_path: normalizedPath,
            upload_date: new Date().toISOString(),
          },
        });
        return true;
      } catch (error: any) {
        const isRateLimit = error?.status === 429 || error?.message?.includes("Too many");
        const isInvalidType = error?.message?.includes("Invalid file type");

        if (isInvalidType) {
          console.error(`❌ Unsupported file type: ${normalizedPath}`);
          return false;
        }

        if (isRateLimit && attempt < retries) {
          const backoffMs = UPLOAD_DELAY_MS * Math.pow(2, attempt - 1);
          console.warn(`⚠️  Rate limit reached. Waiting ${backoffMs}ms before retry (${attempt}/${retries})...`);
          await sleep(backoffMs);
          continue;
        }

        console.error(`❌ Error uploading ${normalizedPath}:`, error.message || error);
        return false;
      }
    }
    return false;
  } finally {
    if (tempFile) {
      try {
        await fs.unlink(tempFile);
      } catch {
      }
    }
  }
}

async function main() {
  const pc = new Pinecone({ apiKey: PINECONE_API_KEY });
  const assistant = pc.assistant(PINECONE_ASSISTANT_NAME);

  const pattern = [`${DOCS_DIR.replaceAll(path.sep, "/")}/**/*`];
  const files = await fg(pattern, { onlyFiles: true, dot: false });

  const picked = files.filter(shouldKeep);
  const extsList = CONVERT_MDX ? [...EXTENSIONS, ".mdx (→ .md)"].join(", ") : EXTENSIONS.join(", ");
  console.log(`Candidate files: ${picked.length} (exts: ${extsList})`);

  if (DELETE_ALL) {
    console.log(`\nDeleting existing files with matching names...`);
    const existingFilesResponse = await assistant.listFiles();
    const existingFiles = existingFilesResponse.files || [];

    const localPaths = new Set(
      picked.map((file) => file.replaceAll(path.sep, "/"))
    );

    let deleted = 0;
    for (const file of existingFiles) {
      const sourcePath = file.metadata?.source_path;
      if (sourcePath && localPaths.has(sourcePath)) {
        await assistant.deleteFile(file.id);
        console.log(`Deleted: ${file.name} (${sourcePath})`);
        deleted++;
      }
    }
    console.log(`Deleted ${deleted} existing file(s).\n`);
  }

  let uploaded = 0;
  let skipped = 0;

  for (let i = 0; i < picked.length; i++) {
    const file = picked[i];
    const isValid = await checkFileSize(file);
    if (!isValid) {
      skipped++;
      continue;
    }

    const normalizedPath = file.replaceAll(path.sep, "/");

    const success = await uploadWithRetry(assistant, file, normalizedPath);
    if (success) {
      uploaded++;
      console.log(`[${uploaded}/${picked.length}] Uploaded: ${normalizedPath}`);
    } else {
      skipped++;
    }

    if (i < picked.length - 1) {
      await sleep(UPLOAD_DELAY_MS);
    }
  }

  console.log(`\nCompleted. Assistant: ${PINECONE_ASSISTANT_NAME}. Uploaded: ${uploaded}. Skipped: ${skipped}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});