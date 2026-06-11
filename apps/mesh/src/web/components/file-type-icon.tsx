/**
 * FileTypeIcon — Untitled UI-style file icon: file body with a folded
 * corner plus a colored extension badge (PDF red, XLS green, …).
 * Parametric SVG instead of vendored per-type assets, so any extension
 * renders; unknown ones get a gray badge, extension-less names get the
 * plain file shape. Body uses design tokens (dark-mode aware); badge
 * colors are brand constants by type bucket.
 */

import type { SVGProps } from "react";

const BADGE_COLORS: Record<string, string> = {
  // documents
  pdf: "#D92D20",
  doc: "#155EEF",
  docx: "#155EEF",
  txt: "#475467",
  md: "#475467",
  // spreadsheets / data
  xls: "#099250",
  xlsx: "#099250",
  csv: "#099250",
  tsv: "#099250",
  json: "#475467",
  xml: "#475467",
  yaml: "#475467",
  yml: "#475467",
  // presentations
  ppt: "#DC6803",
  pptx: "#DC6803",
  key: "#DC6803",
  // images
  png: "#7F56D9",
  jpg: "#7F56D9",
  jpeg: "#7F56D9",
  gif: "#7F56D9",
  webp: "#7F56D9",
  svg: "#7F56D9",
  avif: "#7F56D9",
  // audio / video
  mp3: "#DD2590",
  wav: "#DD2590",
  mp4: "#DD2590",
  mov: "#DD2590",
  webm: "#DD2590",
  // archives
  zip: "#475467",
  tar: "#475467",
  gz: "#475467",
  rar: "#475467",
  // web / code
  html: "#DC6803",
  htm: "#DC6803",
  css: "#155EEF",
  js: "#155EEF",
  jsx: "#155EEF",
  ts: "#155EEF",
  tsx: "#155EEF",
  py: "#155EEF",
  sql: "#155EEF",
  sh: "#475467",
};

const DEFAULT_BADGE_COLOR = "#475467";

const TYPE_LABELS: Record<string, string> = {
  pdf: "PDF",
  doc: "Word document",
  docx: "Word document",
  txt: "Text file",
  md: "Markdown",
  xls: "Excel file",
  xlsx: "Excel file",
  csv: "CSV file",
  tsv: "TSV file",
  json: "JSON file",
  xml: "XML file",
  yaml: "YAML file",
  yml: "YAML file",
  ppt: "Presentation",
  pptx: "Presentation",
  key: "Presentation",
  png: "Image",
  jpg: "Image",
  jpeg: "Image",
  gif: "Image",
  webp: "Image",
  svg: "Image",
  avif: "Image",
  mp3: "Audio",
  wav: "Audio",
  mp4: "Video",
  mov: "Video",
  webm: "Video",
  zip: "Archive",
  tar: "Archive",
  gz: "Archive",
  rar: "Archive",
  html: "HTML file",
  htm: "HTML file",
};

/** Human label for a file's type ("Excel file", "PDF", …) — Library cards. */
export function describeFileType(filename: string): string {
  const ext = extensionOf(filename);
  if (!ext) return "File";
  return TYPE_LABELS[ext] ?? `${ext.toUpperCase()} file`;
}

function extensionOf(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  // Anything longer than 4 chars stops reading as an extension badge.
  if (ext.length > 4 || !/^[a-z0-9]+$/.test(ext)) return null;
  return ext;
}

export function FileTypeIcon({
  filename,
  ...props
}: { filename: string } & SVGProps<SVGSVGElement>) {
  const ext = extensionOf(filename);
  const color = ext ? (BADGE_COLORS[ext] ?? DEFAULT_BADGE_COLOR) : null;
  const label = ext?.toUpperCase() ?? "";
  // Badge hugs its text: ~4.6 units/char + padding, never past the body.
  const badgeWidth = Math.min(8 + label.length * 4.6, 28);

  return (
    <svg
      viewBox="0 0 32 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      {/* file body with folded top-right corner */}
      <path
        d="M19.5 1H8a4 4 0 0 0-4 4v30a4 4 0 0 0 4 4h16a4 4 0 0 0 4-4V9.5L19.5 1Z"
        className="fill-background stroke-border"
        strokeWidth="1.5"
      />
      <path
        d="M19.5 1v4.5a4 4 0 0 0 4 4H28"
        className="stroke-border"
        strokeWidth="1.5"
      />
      {ext && color && (
        <>
          <rect
            x="1"
            y="20"
            width={badgeWidth}
            height="12"
            rx="3"
            fill={color}
          />
          <text
            x={1 + badgeWidth / 2}
            y="29"
            textAnchor="middle"
            fontSize="7"
            fontWeight="700"
            letterSpacing="0.2"
            fill="#FFFFFF"
            style={{ fontFamily: "inherit" }}
          >
            {label}
          </text>
        </>
      )}
    </svg>
  );
}
