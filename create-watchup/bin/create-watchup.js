#!/usr/bin/env node

require("../src/index").main(process.argv.slice(2)).catch((error) => {
  console.error(`\n[watchup] ${error.message}`);
  process.exit(1);
});
