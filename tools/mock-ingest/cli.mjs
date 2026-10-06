#!/usr/bin/env node
// Run the mock ingest server standalone:
//   node tools/mock-ingest/cli.mjs [--port 4318] [--key wup_pub_test]...

import { createMockIngest } from './server.mjs';

const args = process.argv.slice(2);
let port = 4318;
const keys = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--key') keys.push(args[++i]);
}

const mock = createMockIngest(keys.length ? { keys } : undefined);
const url = await mock.listen(port);
console.log(`[mock-ingest] listening on ${url}`);

const stop = () => mock.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
