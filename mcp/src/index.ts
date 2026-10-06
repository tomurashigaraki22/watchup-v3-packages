#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/mcp  ·  stdio entry point
//
//   watchup-mcp                 run the MCP server over stdio
//   watchup-mcp --version       print the package version
//   watchup-mcp --print-schema  print the versioned tool schema (JSON)
// ─────────────────────────────────────────────────────────────────────────────

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createWatchupServer, envFromProcess } from './server.js';
import { toolSchema } from './schema.js';
import { SDK_VERSION } from './version.js';

async function main(argv: string[]): Promise<void> {
  if (argv.includes('--version')) {
    process.stdout.write(`${SDK_VERSION}\n`);
    return;
  }
  if (argv.includes('--print-schema')) {
    process.stdout.write(`${JSON.stringify(await toolSchema(), null, 2)}\n`);
    return;
  }
  const server = createWatchupServer({ env: envFromProcess() });
  await server.connect(new StdioServerTransport());
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', event: 'startup_failed', error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
