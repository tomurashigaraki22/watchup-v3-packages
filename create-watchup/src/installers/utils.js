const fs = require("node:fs");
const path = require("node:path");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeFileIfMissing(filePath, contents) {
  if (fs.existsSync(filePath)) return false;
  ensureDir(filePath);
  fs.writeFileSync(filePath, contents, "utf8");
  return true;
}

/** Append missing `KEY=value` lines to an env file. Existing keys are never touched. */
function appendEnv(cwd, entries, file = ".env.local") {
  const envPath = path.join(cwd, file);
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = [];

  for (const [key, value] of Object.entries(entries)) {
    const present = new RegExp(`^\\s*${key}\\s*=`, "m").test(current);
    if (!present) lines.push(`${key}=${value}`);
  }

  if (lines.length === 0) return false;
  fs.appendFileSync(envPath, `${current.endsWith("\n") || !current ? "" : "\n"}${lines.join("\n")}\n`);
  return true;
}

function findFirst(cwd, candidates) {
  return candidates.map((file) => path.join(cwd, file)).find((file) => fs.existsSync(file));
}

/** True when any of `files` (relative to cwd) already mentions `needle`. */
function alreadyMentions(cwd, files, needle) {
  return files.some((file) => {
    const full = path.join(cwd, file);
    return fs.existsSync(full) && fs.readFileSync(full, "utf8").includes(needle);
  });
}

/**
 * Classify a WatchUp key. `wup_live_` keys are secret (server only);
 * `wup_pub_` keys and legacy project IDs are public (safe in browser code).
 */
function keyKind(apiKey) {
  if (!apiKey) return "none";
  if (apiKey.startsWith("wup_live_")) return "secret";
  return "public";
}

const PLACEHOLDER_PUBLIC = "wup_pub_xxx";
const PLACEHOLDER_SECRET = "wup_live_xxx";

/** Refuse to put a secret key into a variable that is bundled into client code. */
function assertPublicKey(apiKey, variable) {
  if (keyKind(apiKey) === "secret") {
    throw new Error(
      `${variable} is bundled into client code, so it must be a public wup_pub_ key. ` +
        "The wup_live_ key you passed is secret — use it only in server environment variables.",
    );
  }
}

module.exports = {
  appendEnv,
  alreadyMentions,
  assertPublicKey,
  findFirst,
  keyKind,
  writeFileIfMissing,
  PLACEHOLDER_PUBLIC,
  PLACEHOLDER_SECRET,
};
