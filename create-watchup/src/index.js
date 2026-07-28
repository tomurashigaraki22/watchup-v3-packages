const path = require("path");
const { detectFramework, detectPackageManager } = require("./detect");
const { installPackages } = require("./package-manager");
const { ask, confirm } = require("./prompts");
const { installNext } = require("./installers/next");
const { installReact } = require("./installers/react");
const { installNode } = require("./installers/node");
const { installExpress } = require("./installers/express");

const installers = {
  next: installNext,
  react: installReact,
  node: installNode,
  express: installExpress,
};

function parseArgs(argv) {
  const args = { framework: null, apiKey: "", yes: false, install: true };

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--yes" || value === "-y") args.yes = true;
    else if (value === "--no-install") args.install = false;
    else if (value === "--api-key") args.apiKey = argv[++i] || "";
    else if (value.startsWith("--api-key=")) args.apiKey = value.slice("--api-key=".length);
    else if (!value.startsWith("-") && !args.framework) args.framework = value.toLowerCase();
  }

  return args;
}

function printHelp() {
  console.log(`create-watchup

Usage:
  npx create-watchup@latest [framework] [options]

Frameworks:
  next, react, node, express

Options:
  --api-key <key>   WatchUp project API key
  --yes, -y         Skip confirmation prompts
  --no-install      Create files without installing packages
`);
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const args = parseArgs(argv);
  let framework = args.framework || detectFramework(cwd);

  if (!framework) {
    framework = await ask("Which framework? (next/react/node/express) ");
  }

  if (!installers[framework]) {
    throw new Error(`Unsupported framework "${framework}". Use next, react, node, or express.`);
  }

  const apiKey = args.apiKey || await ask("WatchUp API key (leave blank to add placeholder): ", "");
  const packageManager = detectPackageManager(cwd);

  console.log(`\nWatchUp setup`);
  console.log(`  Project: ${path.basename(cwd)}`);
  console.log(`  Framework: ${framework}`);
  console.log(`  Package manager: ${packageManager}`);

  if (!args.yes) {
    const ok = await confirm("Continue?");
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  const result = await installers[framework]({ cwd, apiKey });

  if (args.install) {
    installPackages({ cwd, packageManager, packages: result.packages });
  }

  console.log("\nWatchUp setup complete.");
  if (result.created.length) {
    console.log(`Created/updated: ${result.created.join(", ")}`);
  }
  if (result.notes.length) {
    console.log("\nNext steps:");
    for (const note of result.notes) console.log(`  - ${note}`);
  }
  console.log("\nVerify by opening your WatchUp project and checking Live logs after app activity.");
}

module.exports = { main, parseArgs };
