import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Feature Request - MCP Mesh",
  description:
    "Propose a feature for MCP Mesh. Chat with our AI tech lead to shape your idea into a clear plan.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
