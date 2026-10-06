// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/mcp  ·  versioned tool schema
//
// The schema is read through the MCP protocol itself (tools/list), so it is
// exactly what clients see. `mcp/tool-schema.json` is the committed copy; a
// test fails when the tools change without regenerating it
// (`npm run schema -w mcp`) and bumping SCHEMA_VERSION for breaking changes.
// ─────────────────────────────────────────────────────────────────────────────

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWatchupServer, envFromProcess } from './server.js';

/** Bump the major part for removed tools/arguments, minor for additions. */
export const SCHEMA_VERSION = '2.0';

export interface ToolSchema {
  schema_version: string;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

export async function toolSchema(): Promise<ToolSchema> {
  const server = createWatchupServer({ env: envFromProcess({}) });
  const client = new Client({ name: 'schema-export', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return {
    schema_version: SCHEMA_VERSION,
    tools: tools
      .map(({ name, description, inputSchema }) => ({ name, ...(description && { description }), inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
