import { describe, expect, test } from "bun:test";
import {
  buildConnectionsBlock,
  type ConnectionsBlockTool,
} from "./connections-block";

const tool = (
  rawName: string,
  safeName: string,
  connectionId: string,
): ConnectionsBlockTool => ({ rawName, safeName, connectionId });

const titleMap = (entries: Array<[string, string]>): Map<string, string> =>
  new Map(entries);

describe("buildConnectionsBlock", () => {
  test("returns null when there are no tools", () => {
    expect(buildConnectionsBlock([], titleMap([]))).toBeNull();
  });

  test("groups tools by connection and emits their safe names", () => {
    const result = buildConnectionsBlock(
      [
        tool("send_email", "send_email", "conn_gmail"),
        tool("list_inbox", "list_inbox", "conn_gmail"),
        tool("post_message", "post_message", "conn_slack"),
      ],
      titleMap([
        ["conn_gmail", "Gmail"],
        ["conn_slack", "Slack"],
      ]),
    );
    expect(result).toContain("<available-connections>");
    expect(result).toContain("name,tools");
    expect(result).toContain(`Gmail,"send_email; list_inbox"`);
    expect(result).toContain(`Slack,post_message`);
    expect(result).toContain("<connections-usage>");
    expect(result).toContain("enable_tool");
  });

  test("emits collision-prefixed safe names verbatim", () => {
    const result = buildConnectionsBlock(
      [
        tool("send_email", "conn_gmail_send_email", "conn_gmail"),
        tool("send_email", "conn_outlook_send_email", "conn_outlook"),
      ],
      titleMap([
        ["conn_gmail", "Gmail"],
        ["conn_outlook", "Outlook"],
      ]),
    );
    expect(result).toContain(`Gmail,conn_gmail_send_email`);
    expect(result).toContain(`Outlook,conn_outlook_send_email`);
  });

  test("falls back to the connection id when no title is mapped", () => {
    const result = buildConnectionsBlock(
      [tool("ping", "ping", "conn_unknown")],
      titleMap([]),
    );
    expect(result).toContain(`conn_unknown,ping`);
  });

  test("sorts connections lexicographically by title for cache stability", () => {
    const result = buildConnectionsBlock(
      [tool("b", "b", "conn_b"), tool("a", "a", "conn_a")],
      titleMap([
        ["conn_a", "Zeta"],
        ["conn_b", "Alpha"],
      ]),
    );
    const idxAlpha = result!.indexOf("Alpha,");
    const idxZeta = result!.indexOf("Zeta,");
    expect(idxAlpha).toBeGreaterThan(-1);
    expect(idxZeta).toBeGreaterThan(idxAlpha);
  });

  test("escapes CSV-special characters in connection titles per RFC 4180", () => {
    const result = buildConnectionsBlock(
      [
        tool("send", "send", "conn_a"),
        tool("post", "post", "conn_b"),
        tool("call", "call", "conn_c"),
      ],
      titleMap([
        ["conn_a", "A, comma"],
        ["conn_b", `B "quote"`],
        ["conn_c", "C\nnewline"],
      ]),
    );
    expect(result).toContain(`"A, comma",send`);
    expect(result).toContain(`"B ""quote""",post`);
    expect(result).toContain(`"C\nnewline",call`);
  });

  test("does not split tool names that contain underscores", () => {
    const result = buildConnectionsBlock(
      [
        tool("delete_message", "delete_message", "conn_slack"),
        tool("list_channels", "list_channels", "conn_slack"),
      ],
      titleMap([["conn_slack", "Slack"]]),
    );
    expect(result).toContain(`Slack,"delete_message; list_channels"`);
  });
});
