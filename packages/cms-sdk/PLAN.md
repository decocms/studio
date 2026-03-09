# @deco/cms-sdk

## Overview

SDK package for Content Management System operations. This package provides:
- Daemon client for real-time file operations
- Block utilities (CRUD, path conversion, metadata)
- Schema fetching and resolution
- Preview URL generation

## Why a Separate Package?

1. **Reusability** - Can be used by both `apps/cms` and `apps/web`
2. **Testing** - Easier to test SDK logic in isolation
3. **Versioning** - Can evolve independently of UI
4. **Clarity** - Clear separation between SDK and UI layers

## Directory Structure

```
packages/cms-sdk/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Main exports
│   ├── daemon/
│   │   ├── client.ts         # WebSocket daemon client
│   │   ├── events.ts         # Event types
│   │   └── index.ts
│   ├── blocks/
│   │   ├── decofile.ts       # Path <-> ID conversion
│   │   ├── metadata.ts       # Block metadata inference
│   │   ├── crud.ts           # CRUD operations
│   │   └── index.ts
│   ├── schema/
│   │   ├── fetcher.ts        # /live/_meta fetching
│   │   ├── resolver.ts       # $ref resolution
│   │   └── index.ts
│   ├── preview/
│   │   ├── url-builder.ts    # Preview URL generation
│   │   └── index.ts
│   └── types/
│       ├── block.ts          # Block type definitions
│       ├── meta.ts           # MetaInfo types
│       └── index.ts
└── tests/
    ├── daemon.test.ts
    ├── blocks.test.ts
    └── schema.test.ts
```

## Core Modules

### daemon/client.ts

WebSocket client for real-time file operations.

```typescript
export interface DaemonConfig {
  siteUrl: string;
  env: string;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

export interface DaemonEvent {
  type: 'fs-sync' | 'fs-snapshot' | 'meta-info' | 'worker-status';
  detail: unknown;
}

export class DaemonClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  
  constructor(private config: DaemonConfig) {}
  
  async connect(): Promise<void> {
    // Connect to daemon watch endpoint
  }
  
  async *watch(): AsyncIterableIterator<DaemonEvent> {
    // Yield events from WebSocket
  }
  
  async readFile(path: string): Promise<string> {
    // Read file via daemon API
  }
  
  async writeFile(path: string, content: string): Promise<void> {
    // Write file via daemon API
  }
  
  async deleteFile(path: string): Promise<void> {
    // Delete file via daemon API
  }
  
  async listFiles(prefix?: string): Promise<string[]> {
    // List files via daemon API
  }
  
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}
```

### blocks/decofile.ts

Utilities for block ID <-> file path conversion.

```typescript
const DECO_FOLDER = '.deco';
const BLOCKS_FOLDER = `/${DECO_FOLDER}/blocks`;

export const DECOFILE = {
  paths: {
    blocks: {
      // Convert block ID to file path
      fromId: (blockId: string): string => {
        return `${BLOCKS_FOLDER}/${encodeURIComponent(blockId)}.json`;
      },
      
      // Convert file path to block ID
      toId: (path: string): string | null => {
        if (!path.startsWith(BLOCKS_FOLDER)) return null;
        const filename = path.slice(BLOCKS_FOLDER.length + 1);
        return decodeURIComponent(filename.replace('.json', ''));
      },
    },
    
    blocksFolder: BLOCKS_FOLDER,
    metadataPath: `/${DECO_FOLDER}/metadata.json`,
  },
};
```

### blocks/metadata.ts

Infer block type and metadata from block content.

```typescript
export interface BlockMetadata {
  blockType: BlockType;
  __resolveType: string;
  name?: string;
  path?: string;
}

export type BlockType = 
  | 'pages' 
  | 'sections' 
  | 'loaders' 
  | 'actions' 
  | 'apps' 
  | 'flags' 
  | 'handlers' 
  | 'matchers'
  | 'workflows';

export function inferMetadata(block: Block): BlockMetadata | null {
  const resolveType = block.__resolveType;
  if (!resolveType) return null;
  
  // Determine block type from __resolveType
  const blockType = getBlockType(resolveType);
  
  return {
    blockType,
    __resolveType: resolveType,
    name: block.name as string | undefined,
    path: block.path as string | undefined,
  };
}

function getBlockType(resolveType: string): BlockType {
  if (resolveType.includes('/pages/')) return 'pages';
  if (resolveType.includes('/sections/')) return 'sections';
  if (resolveType.includes('/loaders/')) return 'loaders';
  if (resolveType.includes('/actions/')) return 'actions';
  if (resolveType.includes('/apps/')) return 'apps';
  if (resolveType.includes('/flags/')) return 'flags';
  if (resolveType.includes('/handlers/')) return 'handlers';
  if (resolveType.includes('/matchers/')) return 'matchers';
  if (resolveType.includes('/workflows/')) return 'workflows';
  return 'sections'; // default
}
```

### schema/fetcher.ts

Fetch and cache schema from deco runtime.

```typescript
export interface MetaInfo {
  version: string;
  namespace: string;
  site: string;
  etag: string;
  timestamp: number;
  schema: JSONSchema;
  manifest: {
    blocks: Record<string, Record<string, JSONSchema>>;
  };
}

export async function fetchMeta(siteUrl: string): Promise<MetaInfo> {
  const response = await fetch(`${siteUrl}/live/_meta`, {
    headers: {
      'Accept': 'application/json',
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch meta: ${response.status}`);
  }
  
  return response.json();
}

export function getBlockSchema(
  meta: MetaInfo,
  resolveType: string
): JSONSchema | null {
  for (const [_, blocks] of Object.entries(meta.manifest.blocks)) {
    if (blocks[resolveType]) {
      return {
        ...meta.schema,
        ...blocks[resolveType],
      };
    }
  }
  return null;
}
```

### preview/url-builder.ts

Build preview URLs for the iframe.

```typescript
export interface PreviewOptions {
  path?: string;
  pathTemplate?: string;
  viewport?: 'mobile' | 'tablet' | 'desktop';
  matchers?: Record<string, boolean>;
  cacheBuster?: string;
}

export function buildPreviewUrl(
  siteUrl: string,
  block: Block,
  options: PreviewOptions = {}
): string {
  const { __resolveType, ...props } = block;
  
  if (!__resolveType) {
    throw new Error('Block must have __resolveType');
  }
  
  const url = new URL(`${siteUrl}/live/previews/${__resolveType}`);
  
  // Path parameters
  url.searchParams.set('path', options.path || '/');
  url.searchParams.set('pathTemplate', options.pathTemplate || options.path || '/');
  
  // Props (encoded)
  url.searchParams.set('props', encodeProps(JSON.stringify(props)));
  
  // Viewport hint
  if (options.viewport) {
    url.searchParams.set('deviceHint', options.viewport);
  }
  
  // Matcher overrides
  if (options.matchers) {
    for (const [matcherId, active] of Object.entries(options.matchers)) {
      url.searchParams.append('x-deco-matchers-override', `${matcherId}=${active ? 1 : 0}`);
    }
  }
  
  // Disable async rendering
  url.searchParams.set('__decoFBT', '0');
  url.searchParams.set('__d', '');
  
  // Cache buster
  url.searchParams.set('__cb', options.cacheBuster || Date.now().toString());
  
  return url.toString();
}

function encodeProps(props: string): string {
  return btoa(encodeURIComponent(props));
}

export function decodeProps(encoded: string): string {
  return decodeURIComponent(atob(encoded));
}
```

## Exports

```typescript
// src/index.ts
export { DaemonClient, type DaemonConfig, type DaemonEvent } from './daemon';
export { DECOFILE, inferMetadata, type BlockMetadata, type BlockType } from './blocks';
export { fetchMeta, getBlockSchema, type MetaInfo } from './schema';
export { buildPreviewUrl, type PreviewOptions } from './preview';
export * from './types';
```

## Dependencies

```json
{
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.0.0",
    "vitest": "^1.0.0"
  },
  "peerDependencies": {}
}
```

## Porting from admin-cx

Key files to reference:
- `admin-cx/sdk/decofile.json.ts` → `blocks/decofile.ts`
- `admin-cx/sdk/metadata.ts` → `blocks/metadata.ts`
- `admin-cx/sdk/environment.tsx` → `schema/fetcher.ts`
- `admin-cx/components/spaces/siteEditor/sdk.ts` → `daemon/client.ts`
- `admin-cx/components/pages/block-edit/state.tsx` → `preview/url-builder.ts`

