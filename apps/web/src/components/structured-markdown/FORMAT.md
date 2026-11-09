# Structured Markdown blocks

Implementation contract for writers of task descriptions and other content rendered by `MemoizedMarkdown`. These are top-level fenced code blocks containing JSON, not MDX or executable components. [schema.ts](./schema.ts) owns validation and limits. Unknown versions, invalid payloads and incomplete streamed JSON render as ordinary code, preserving the source for correction.

## External messages

Use `gchat`, `whatsapp`, `slack` or `email` as the fence language. They share one schema:

````markdown
```gchat
{
  "version": 1,
  "author": {
    "name": "Alex Example",
    "avatarUrl": "https://example.com/avatar.png"
  },
  "channel": "Website support",
  "url": "https://example.com/messages/123",
  "sentAt": "2026-01-15T10:30:00-03:00",
  "body": "Dragging the list does nothing on desktop. **Touch works.**",
  "attachments": [
    {
      "name": "Reported behavior",
      "url": "https://example.com/report.png",
      "kind": "image"
    }
  ]
}
```
````

`author.name` and `body` are required. Copy the sender's display name from the source. Omit unavailable optional fields; keep the report distinct from the agent's diagnosis. Label a paraphrase or historical reconstruction in the body rather than presenting it as a verbatim message. `body` supports ordinary Markdown, without raw HTML or recursive structured blocks. Attachments use `image` or `file`; videos remain file links. Timestamps require an ISO date with timezone.

## Testing

````markdown
```testing
{
  "version": 1,
  "title": "Test the change",
  "previewUrl": "https://preview.example.com/looks",
  "pullRequest": {
    "url": "https://github.com/example/storefront/pull/42",
    "title": "Enable mouse dragging"
  },
  "note": "Automated test passes. Browser validation is still pending.",
  "steps": [
    {
      "action": "On desktop, drag the thumbnails horizontally.",
      "expected": "The list follows the pointer without opening a thumbnail."
    }
  ]
}
```
````

`steps` is required, with at least one `action`. `expected`, title, note, preview and pull request are optional. Put the complete destination URL in `previewUrl`, including the page path. This renders a collapsed accordion; links only navigate. It does not run tests, approve a task, merge a PR or prove that a preview is available. Write validation evidence and remaining checks in `note`.

All URL fields accept absolute HTTP(S) URLs without embedded credentials. Serialize payloads with `JSON.stringify` to preserve newlines and quotation marks in messages. Both block types accept `version: 1`; omission defaults to 1. The description editor retains the language and JSON when saving, showing source code while editing. Multiple blocks render in document order.
