const { spawnSync } = require("child_process");

function installPackages({ cwd, packageManager, packages }) {
  const argsByManager = {
    npm: ["install", ...packages],
    pnpm: ["add", ...packages],
    yarn: ["add", ...packages],
    bun: ["add", ...packages],
  };

  const command = packageManager;
  const args = argsByManager[packageManager] || argsByManager.npm;
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: true });

  if (result.status !== 0) {
    throw new Error(`Package install failed: ${command} ${args.join(" ")}`);
  }
}

module.exports = { installPackages };
