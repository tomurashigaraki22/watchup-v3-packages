const fs = require("fs");
const path = require("path");

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

function detectFramework(cwd) {
  const pkg = readJson(cwd, "package.json");
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  if (deps.next || exists(cwd, "next.config.js") || exists(cwd, "next.config.mjs")) return "next";
  if (deps["react-native"] || deps.expo || exists(cwd, "app.json") || exists(cwd, "app.config.js") || exists(cwd, "app.config.ts")) return "react-native";
  if (deps.express) return "express";
  if (deps.react || exists(cwd, "vite.config.js") || exists(cwd, "vite.config.ts")) return "react";
  if (pkg) return "node";

  return null;
}

function detectPackageManager(cwd) {
  if (exists(cwd, "pnpm-lock.yaml")) return "pnpm";
  if (exists(cwd, "yarn.lock")) return "yarn";
  if (exists(cwd, "bun.lockb") || exists(cwd, "bun.lock")) return "bun";
  return "npm";
}

module.exports = { detectFramework, detectPackageManager, readJson };
