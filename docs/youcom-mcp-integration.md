# You.com MCP Server Integration

This integration adds You.com as a predefined MCP (Model Context Protocol) server option in deco Studio, enabling agents to perform web search, content extraction, and research through You.com's API.

## Features

- **Web Search**: Access to You.com's web search capabilities via `you-search` tool
- **Content Extraction**: Extract content from URLs using `you-contents` tool  
- **Research**: Synthesized research with citations via `you-research` tool
- **Flexible Authentication**: Supports both authenticated (API key) and keyless operation
- **Keyless Operation**: 100 free searches per day per IP without requiring an API key

## Setup

1. **Create Connection**: In Studio, go to Connections and click "Create Connection"
2. **Select Server Type**: Choose "SSE" as the connection type
3. **Enter URL**: Use `https://api.you.com/mcp` as the server URL
4. **Authentication (Optional)**: 
   - For authenticated access: Enter your You.com API key in the token field
   - For keyless access: Leave the token field empty
5. **Save**: Click "Create Connection" to add the You.com MCP server

## Authentication Options

### Authenticated Access (Recommended for Production)
- Requires a You.com API key from [you.com/platform/api-keys](https://you.com/platform/api-keys)
- Higher rate limits and enhanced features
- Enter the API key in the "You.com API Key (optional)" field

### Keyless Access (Good for Testing)
- No API key required
- 100 free searches per day per IP address
- Leave the token field empty during connection setup

## Available Tools

Once connected, agents gain access to these MCP tools:

- **you-search**: Perform web searches with customizable parameters
- **you-contents**: Extract structured content from web URLs
- **you-research**: Get synthesized research results with citations

## Usage Examples

After setting up the connection, agents can use commands like:
- "Search for the latest TypeScript updates"
- "Extract content from this documentation URL"
- "Research the current state of AI agent frameworks"

## Error Handling

The integration includes graceful error handling for:
- Rate limit responses (429) with upgrade suggestions
- Invalid API key errors (401) with clear guidance
- Network failures with context and recovery suggestions
- Malformed responses with validation and helpful error messages

## Integration Details

- **Connection Type**: SSE (Server-Sent Events)
- **Server URL**: `https://api.you.com/mcp`
- **Provider ID**: `youcom`
- **Authentication**: Bearer token (optional)
- **Fallback**: Automatic keyless operation when no API key provided