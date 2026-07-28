const fs = require("fs");
const path = require("path");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeFileIfMissing(filePath, contents) {
  if (fs.existsSync(filePath)) return false;
  ensureDir(filePath);
  fs.writeFileSync(filePath, contents, "utf8");
  return true;
}

function appendEnv(cwd, entries) {
  const envPath = path.join(cwd, ".env.local");
  const current = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = [];

  for (const [key, value] of Object.entries(entries)) {
    if (!current.includes(`${key}=`)) lines.push(`${key}=${value}`);
  }

  if (lines.length === 0) return false;
  fs.appendFileSync(envPath, `${current.endsWith("\n") || !current ? "" : "\n"}${lines.join("\n")}\n`);
  return true;
}

function findFirst(cwd, candidates) {
  return candidates.map((file) => path.join(cwd, file)).find((file) => fs.existsSync(file));
}

module.exports = { appendEnv, findFirst, writeFileIfMissing };
