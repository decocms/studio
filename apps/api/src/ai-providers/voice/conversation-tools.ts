export const VOICE_CONVERSATION_TOOLS = [
  {
    name: "delegate_to_agent",
    description:
      "Submit a complete request to the selected Studio agent. Returns after acceptance while work continues in the background. Results arrive later.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "The complete user request, with relevant conversational details. Preserve intent and constraints.",
        },
      },
      required: ["request"],
    },
  },
  {
    name: "get_agent_status",
    description:
      "Read the current chat's work status and known results. This does not track independent organization tasks; delegate fresh task-status queries to the Studio agent. Use when asked, never poll.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "stop_agent_work",
    description:
      "Request cancellation in the current chat ONLY when the user explicitly asks. Speaking over the companion is not cancellation. To stop independent tasks, delegate that request to the Studio agent.",
    parameters: { type: "object", properties: {} },
  },
];
