const path = require("node:path");
const { detectFramework, detectPackageManager, detectUnsupported } = require("./detect");
const { installPackages, verifyPublished, PACKAGE_MAP } = require("./package-manager");
const { ask, confirm } = require("./prompts");
const { installNext } = require("./installers/next");
const { installReact } = require("./installers/react");
const { installReactNative } = require("./installers/react-native");
const { installSvelte } = require("./installers/svelte");
const { installNode } = require("./installers/node");
const { installExpress } = require("./installers/express");

const installers = {
  next: installNext,
  react: installReact,
  "react-native": installReactNative,
  svelte: installSvelte,
  node: installNode,
  express: installExpress,
};

const FRAMEWORKS = Object.keys(installers).join(", ");

function parseArgs(argv) {
  const args = { framework: null, apiKey: "", yes: false, install: true, verify: true };

  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--yes" || value === "-y") args.yes = true;
    else if (value === "--no-install") args.install = false;
    else if (value === "--skip-verify") args.verify = false;
    else if (value === "--api-key") args.apiKey = argv[++i] || "";
    else if (value.startsWith("--api-key=")) args.apiKey = value.slice("--api-key=".length);
    else if (!value.startsWith("-") && !args.framework) args.framework = value.toLowerCase();
  }

  return args;
}

function printHelp(log = console.log) {
  log(`create-watchup

Usage:
  npx create-watchup@latest [framework] [options]

Frameworks:
  ${FRAMEWORKS}

Options:
  --api-key <key>   WatchUp key. Public wup_pub_ keys go to browser variables,
                    secret wup_live_ keys only to server variables.
  --yes, -y         Skip confirmation prompts
  --no-install      Create files without installing packages
  --skip-verify     Do not check that packages are published before installing
`);
}

async function main(argv, { cwd = process.cwd(), log = console.log, prompts = { ask, confirm }, install = installPackages, verify = verifyPublished } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp(log);
    return null;
  }

  const args = parseArgs(argv);

  if (!args.framework) {
    const unsupported = detectUnsupported(cwd);
    if (unsupported) {
      throw new Error(`${unsupported.name} projects are not set up by this CLI. Instead: ${unsupported.hint}`);
    }
  }

  let framework = args.framework || detectFramework(cwd);
  if (!framework) {
    if (args.yes) throw new Error(`Could not detect the framework. Pass one of: ${FRAMEWORKS}.`);
    framework = (await prompts.ask(`Which framework? (${FRAMEWORKS}) `)).toLowerCase();
  }

  if (!installers[framework]) {
    throw new Error(`Unsupported framework "${framework}". Use one of: ${FRAMEWORKS}.`);
  }

  const apiKey = args.apiKey || (args.yes ? "" : await prompts.ask("WatchUp API key (leave blank to add placeholders): ", ""));
  const packageManager = detectPackageManager(cwd);

  log(`\nWatchUp setup`);
  log(`  Project: ${path.basename(cwd)}`);
  log(`  Framework: ${framework}`);
  log(`  Package manager: ${packageManager}`);

  if (!args.yes) {
    const ok = await prompts.confirm("Continue?");
    if (!ok) {
      log("Cancelled.");
      return null;
    }
  }

  const packages = PACKAGE_MAP[framework];
  // Fail before touching any file if the packages cannot be installed.
  if (args.install && args.verify) verify(packages);

  const result = await installers[framework]({ cwd, apiKey });

  if (args.install) install({ cwd, packageManager, packages: result.packages });

  log("\nWatchUp setup complete.");
  if (result.created.length) log(`Created/updated: ${result.created.join(", ")}`);
  if (result.notes.length) {
    log("\nNext steps:");
    for (const note of result.notes) log(`  - ${note}`);
  }
  log("\nVerify by opening your WatchUp project and checking Live logs after app activity.");
  return { framework, ...result };
}

module.exports = { main, parseArgs, installers };
