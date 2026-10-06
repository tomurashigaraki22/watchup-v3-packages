const fs = require("node:fs");
const path = require("node:path");

function exists(cwd, file) {
  return fs.existsSync(path.join(cwd, file));
}

function readJson(cwd, file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, file), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Projects this CLI cannot set up, with the right next step. Detected so the
 * CLI fails fast instead of installing an npm package that does not apply.
 */
const UNSUPPORTED = [
  { name: "Python", test: (cwd) => ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some((f) => exists(cwd, f)), hint: "pip install watchup — see https://watchup.site/docs/sdks/python" },
  { name: "Go", test: (cwd) => exists(cwd, "go.mod"), hint: "go get github.com/tomurashigaraki22/watchup-go-sdk — see https://watchup.site/docs/sdks/go" },
  {
    name: ".NET",
    test: (cwd) => {
      try {
        return fs.readdirSync(cwd).some((f) => f.endsWith(".csproj") || f.endsWith(".sln"));
      } catch {
        return false;
      }
    },
    hint: "dotnet add package Watchup — see https://watchup.site/docs/sdks/dotnet",
  },
];

function detectFramework(cwd) {
  const pkg = readJson(cwd, "package.json");
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  if (deps.next || exists(cwd, "next.config.js") || exists(cwd, "next.config.mjs") || exists(cwd, "next.config.ts")) return "next";
  if (deps["react-native"] || deps.expo) return "react-native";
  if (deps["@sveltejs/kit"] || exists(cwd, "svelte.config.js")) return "svelte";
  if (deps.express) return "express";
  if (deps.react) return "react";
  if (pkg) return "node";

  return null;
}

/** JavaScript frameworks without a dedicated installer yet. */
const UNSUPPORTED_JS = {
  vue: "Vue",
  nuxt: "Nuxt",
  "@angular/core": "Angular",
  "solid-js": "Solid",
  astro: "Astro",
  "@remix-run/react": "Remix",
};

/** Return `{ name, hint }` when this CLI cannot set the project up. */
function detectUnsupported(cwd) {
  const pkg = readJson(cwd, "package.json");
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.next || deps["@sveltejs/kit"] || deps["react-native"] || deps.expo) return null;
    const dep = Object.keys(UNSUPPORTED_JS).find((name) => deps[name]);
    return dep
      ? { name: UNSUPPORTED_JS[dep], hint: "use @watchupltd/browser directly — see https://watchup.site/docs/sdks/browser" }
      : null;
  }
  const match = UNSUPPORTED.find((entry) => entry.test(cwd));
  return match ? { name: match.name, hint: match.hint } : null;
}

function detectPackageManager(cwd) {
  if (exists(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (exists(cwd, "yarn.lock")) return "yarn";
  if (exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")) return "bun";
  return "npm";
}

module.exports = { detectFramework, detectPackageManager, detectUnsupported, readJson };
