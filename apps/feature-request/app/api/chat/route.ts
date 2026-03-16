import { SYSTEM_PROMPT } from "@/lib/system-prompt";

export async function POST(req: Request) {
  const { messages } = await req.json();

  const meshUrl = process.env.MESH_URL;
  const apiKey = process.env.MESH_API_KEY;
  const orgSlug = process.env.MESH_ORG_SLUG;
  const agentId = process.env.AGENT_ID;
  const modelConnectionId = process.env.MODEL_CONNECTION_ID;
  const modelId = process.env.MODEL_ID;
  const toolMode = process.env.TOOL_MODE || "smart_tool_selection";

  if (
    !meshUrl ||
    !apiKey ||
    !orgSlug ||
    !agentId ||
    !modelConnectionId ||
    !modelId
  ) {
    return new Response(
      JSON.stringify({
        error: "Server misconfigured — missing environment variables",
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const response = await fetch(`${meshUrl}/api/${orgSlug}/decopilot/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      messages: [
        {
          id: crypto.randomUUID(),
          role: "system",
          parts: [{ type: "text", text: SYSTEM_PROMPT }],
        },
        ...messages,
      ],
      model: {
        id: modelId,
        connectionId: modelConnectionId,
      },
      agent: {
        id: agentId,
        mode: toolMode,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    return new Response(
      JSON.stringify({
        error: `Mesh API error: ${response.status}`,
        details: errorText,
      }),
      {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
