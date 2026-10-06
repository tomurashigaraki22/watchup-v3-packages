const { spawnSync } = require("node:child_process");

/**
 * Package map: what each framework installs. Versions resolve to the latest
 * published release; verifyPublished() fails fast if a package is missing.
 */
const PACKAGE_MAP = {
  next: ["@watchupltd/nextjs", "@watchupltd/browser", "@watchupltd/react", "@watchupltd/node"],
  react: ["@watchupltd/react", "@watchupltd/browser"],
  "react-native": ["@watchupltd/react-native"],
  svelte: ["@watchupltd/svelte", "@watchupltd/browser", "@watchupltd/node"],
  node: ["@watchupltd/node"],
  express: ["@watchupltd/node"],
};

function run(command, args, options) {
  // shell is needed on Windows for npm.cmd; arguments are fixed package names.
  return spawnSync(command, args, { shell: process.platform === "win32", ...options });
}

/** Throw unless every package is published on the npm registry. */
function verifyPublished(packages, { exec = run } = {}) {
  const missing = packages.filter((name) => {
    const result = exec("npm", ["view", name, "version"], { stdio: "pipe", encoding: "utf8" });
    return result.status !== 0 || !String(result.stdout || "").trim();
  });
  if (missing.length) {
    throw new Error(
      `Not published on npm yet: ${missing.join(", ")}. ` +
        "Re-run with --no-install to only create the files, or install the packages manually once they are released.",
    );
  }
}

function installPackages({ cwd, packageManager, packages, exec = run }) {
  const argsByManager = {
    npm: ["install", ...packages],
    pnpm: ["add", ...packages],
    yarn: ["add", ...packages],
    bun: ["add", ...packages],
  };

  const command = argsByManager[packageManager] ? packageManager : "npm";
  const args = argsByManager[command];
  const result = exec(command, args, { cwd, stdio: "inherit" });

  if (result.status !== 0) {
    throw new Error(`Package install failed: ${command} ${args.join(" ")}`);
  }
}

module.exports = { installPackages, verifyPublished, PACKAGE_MAP };
