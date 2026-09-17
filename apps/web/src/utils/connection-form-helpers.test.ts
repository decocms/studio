/**
 * Test cases for You.com MCP provider hint integration
 */

import { describe, it, expect } from 'vitest';
import { 
  inferHardcodedProviderHint,
  type ConnectionProviderHint 
} from '../utils/connection-form-helpers';

describe('You.com MCP Provider Hint', () => {
  it('should recognize You.com MCP server URL', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'SSE',
      connectionUrl: 'https://api.you.com/mcp'
    });

    expect(result).toEqual({
      id: 'youcom',
      title: 'You.com',
      description: 'You.com MCP Server for web search, content extraction, and research',
      token: {
        label: 'You.com API Key (optional)',
        placeholder: 'your_api_key_here',
        helperText: 'Optional API key for authenticated access. Leave blank for keyless operation (100 searches/day)',
      },
    });
  });

  it('should handle URL with trailing slash', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'SSE',
      connectionUrl: 'https://api.you.com/mcp/'
    });

    expect(result?.id).toBe('youcom');
  });

  it('should work with HTTP connection type', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'HTTP',
      connectionUrl: 'https://api.you.com/mcp'
    });

    expect(result?.id).toBe('youcom');
  });

  it('should work with WebSocket connection type', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'Websocket',
      connectionUrl: 'https://api.you.com/mcp'
    });

    expect(result?.id).toBe('youcom');
  });

  it('should not match different URLs', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'SSE',
      connectionUrl: 'https://api.different.com/mcp'
    });

    expect(result?.id).not.toBe('youcom');
  });

  it('should not match STDIO connection type', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'STDIO',
      connectionUrl: 'https://api.you.com/mcp'
    });

    expect(result?.id).not.toBe('youcom');
  });

  it('should not match NPX connection type', () => {
    const result = inferHardcodedProviderHint({
      uiType: 'NPX',
      connectionUrl: 'https://api.you.com/mcp'
    });

    expect(result?.id).not.toBe('youcom');
  });
});