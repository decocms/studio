import { useRef, useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import {
  AlertCircle,
  CheckCircle,
  Download01,
  Upload01,
} from "@untitledui/icons";
import type {
  RegistryBulkCreateResult,
  RegistryCreateInput,
} from "@/web/lib/registry/types";

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isImporting?: boolean;
  onImport: (items: RegistryCreateInput[]) => Promise<RegistryBulkCreateResult>;
}

// ── CSV Parsing ──

function parseList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[;|]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

interface ParseWarning {
  line: number;
  message: string;
}

interface ParseResult {
  items: RegistryCreateInput[];
  warnings: ParseWarning[];
  skipped: number;
}

const REQUIRED_COLUMNS = ["id", "title"];
const KNOWN_COLUMNS = [
  "id",
  "title",
  "description",
  "remote_url",
  "remote_type",
  "tags",
  "categories",
  "is_public",
];

function parseCsvToItems(csvContent: string): ParseResult {
  const lines = csvContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return {
      items: [],
      warnings: [
        {
          line: 0,
          message: "CSV must have a header row and at least one data row",
        },
      ],
      skipped: 0,
    };
  }

  const header = parseCsvLine(lines[0] ?? "");
  const headerIndex = new Map<string, number>();
  const warnings: ParseWarning[] = [];

  header.forEach((column, index) => {
    const normalized = column.toLowerCase().trim();
    if (normalized) {
      headerIndex.set(normalized, index);
    }
  });

  // Check required columns
  for (const col of REQUIRED_COLUMNS) {
    if (!headerIndex.has(col)) {
      warnings.push({ line: 1, message: `Missing required column: "${col}"` });
    }
  }

  // Warn about unknown columns
  for (const col of header) {
    const normalized = col.toLowerCase().trim();
    if (normalized && !KNOWN_COLUMNS.includes(normalized)) {
      warnings.push({
        line: 1,
        message: `Unknown column "${col}" will be ignored`,
      });
    }
  }

  if (!headerIndex.has("id") || !headerIndex.has("title")) {
    return { items: [], warnings, skipped: 0 };
  }

  const getValue = (cells: string[], key: string) => {
    const index = headerIndex.get(key);
    return typeof index === "number" ? (cells[index] ?? "") : "";
  };

  const items: RegistryCreateInput[] = [];
  const seenIds = new Set<string>();
  let skipped = 0;

  for (let index = 1; index < lines.length; index += 1) {
    const cells = parseCsvLine(lines[index] ?? "");
    const id = getValue(cells, "id").trim();
    const title = getValue(cells, "title").trim();

    if (!id) {
      warnings.push({ line: index + 1, message: "Missing id — row skipped" });
      skipped += 1;
      continue;
    }
    if (!title) {
      warnings.push({
        line: index + 1,
        message: `Missing title for id="${id}" — row skipped`,
      });
      skipped += 1;
      continue;
    }
    if (seenIds.has(id)) {
      warnings.push({
        line: index + 1,
        message: `Duplicate id="${id}" — row skipped`,
      });
      skipped += 1;
      continue;
    }
    seenIds.add(id);

    const description = getValue(cells, "description").trim();
    const remoteUrl = getValue(cells, "remote_url").trim();
    const rawType = getValue(cells, "remote_type").trim().toLowerCase();
    const remoteType = rawType === "sse" ? "sse" : "http";
    const tags = parseList(getValue(cells, "tags"));
    const categories = parseList(getValue(cells, "categories"));
    const isPublicRaw = getValue(cells, "is_public").trim().toLowerCase();
    const isPublic =
      isPublicRaw === "true" || isPublicRaw === "1" || isPublicRaw === "yes";

    items.push({
      id,
      title,
      description: description || null,
      is_public: isPublic,
      _meta: {
        "mcp.mesh": {
          ...(tags.length > 0 ? { tags } : {}),
          ...(categories.length > 0 ? { categories } : {}),
        },
      },
      server: {
        name: id,
        title,
        description: description || undefined,
        remotes: remoteUrl ? [{ type: remoteType, url: remoteUrl }] : [],
      },
    });
  }

  return { items, warnings, skipped };
}

// ── CSV Template ──

const CSV_TEMPLATE = `id,title,description,remote_url,remote_type,tags,categories,is_public
my-mcp-server,My MCP Server,A useful MCP server,https://example.com/mcp,http,ai|tools,productivity,true
another-server,Another Server,Another useful server,https://example2.com/mcp,http,data|analytics,data-processing,false`;

function downloadTemplate() {
  const blob = new Blob([CSV_TEMPLATE], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "registry-import-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

// ── Component ──

export function CsvImportDialog({
  open,
  onOpenChange,
  isImporting = false,
  onImport,
}: CsvImportDialogProps) {
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [importResult, setImportResult] =
    useState<RegistryBulkCreateResult | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setParseResult(null);
      setImportResult(null);
      setFileName(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setFileName(file.name);
    setImportResult(null);
    const content = await file.text();
    setParseResult(parseCsvToItems(content));
  };

  const handleImport = async () => {
    if (!parseResult?.items.length) return;
    const result = await onImport(parseResult.items);
    setImportResult(result);
  };

  const items = parseResult?.items ?? [];
  const warnings = parseResult?.warnings ?? [];
  const hasErrors = warnings.some((w) =>
    w.message.startsWith("Missing required column:"),
  );
  const imported = importResult !== null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import MCP Servers from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV file to bulk-import MCP servers into the registry.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto grid gap-4 pr-1">
          {/* Upload area */}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              <Upload01 size={14} />
              {fileName ? "Change file" : "Choose CSV file"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
            />
            {fileName && (
              <span className="text-sm text-muted-foreground truncate">
                {fileName}
              </span>
            )}
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground"
              onClick={downloadTemplate}
            >
              <Download01 size={14} />
              Download template
            </Button>
          </div>

          {/* Warnings */}
          {warnings.length > 0 && (
            <div className="rounded-lg border border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/30 p-3 grid gap-1">
              {warnings.map((w, i) => (
                <p
                  key={`${w.line}-${i}`}
                  className="text-xs text-yellow-700 dark:text-yellow-400 flex items-start gap-1.5"
                >
                  <AlertCircle size={12} className="shrink-0 mt-0.5" />
                  <span>
                    {w.line > 0 && (
                      <span className="font-mono text-[10px] mr-1">
                        Line {w.line}:
                      </span>
                    )}
                    {w.message}
                  </span>
                </p>
              ))}
            </div>
          )}

          {/* Preview table */}
          {items.length > 0 && (
            <>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Preview</span>
                <Badge variant="secondary">{items.length} items</Badge>
                {parseResult?.skipped ? (
                  <Badge variant="outline" className="text-yellow-600">
                    {parseResult.skipped} skipped
                  </Badge>
                ) : null}
              </div>
              <div className="border rounded-lg overflow-hidden">
                <div className="max-h-[300px] overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[140px]">ID</TableHead>
                        <TableHead>Title</TableHead>
                        <TableHead>Remote URL</TableHead>
                        <TableHead className="w-[80px] text-center">
                          Public
                        </TableHead>
                        <TableHead>Tags</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow key={item.id}>
                          <TableCell className="font-mono text-xs">
                            {item.id}
                          </TableCell>
                          <TableCell className="text-sm">
                            {item.title}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                            {item.server.remotes?.[0]?.url ?? (
                              <span className="italic">none</span>
                            )}
                          </TableCell>
                          <TableCell className="text-center">
                            {item.is_public ? (
                              <Badge
                                variant="secondary"
                                className="text-[10px] bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                              >
                                Yes
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">
                                No
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {(item._meta?.["mcp.mesh"]?.tags ?? []).join(
                              ", ",
                            ) || "-"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}

          {/* Import result */}
          {importResult && (
            <div className="rounded-lg border p-3 grid gap-1.5">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle size={16} className="text-emerald-600" />
                Imported {importResult.created} item(s) successfully
              </div>
              {importResult.errors.length > 0 && (
                <div className="grid gap-1 mt-1">
                  {importResult.errors.map((err) => (
                    <p
                      key={err.id}
                      className="text-xs text-destructive flex items-start gap-1.5"
                    >
                      <AlertCircle size={12} className="shrink-0 mt-0.5" />
                      <span>
                        <span className="font-mono">{err.id}</span>: {err.error}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Empty state */}
          {!parseResult && !imported && (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Upload01 size={32} className="text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">
                Choose a CSV file or download the template to get started.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Required columns: <code>id</code>, <code>title</code>. Optional:{" "}
                <code>description</code>, <code>remote_url</code>,{" "}
                <code>remote_type</code>, <code>tags</code>,{" "}
                <code>categories</code>, <code>is_public</code>.
              </p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                Use <code>|</code> or <code>;</code> to separate multiple
                tags/categories within a cell.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {imported ? "Done" : "Cancel"}
          </Button>
          {!imported && (
            <Button
              onClick={handleImport}
              disabled={isImporting || items.length === 0 || hasErrors}
            >
              {isImporting ? "Importing..." : `Import ${items.length} item(s)`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
