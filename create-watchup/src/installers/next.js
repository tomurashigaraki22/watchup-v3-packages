const fs = require("node:fs");
const path = require("node:path");
const {
  appendEnv,
  alreadyMentions,
  findFirst,
  keyKind,
  writeFileIfMissing,
  PLACEHOLDER_PUBLIC,
  PLACEHOLDER_SECRET,
} = require("./utils");

function providerSource() {
  return `"use client";

import { WatchupProvider } from "@watchupltd/nextjs/client";

export default function WatchupInit({ children }) {
  return (
    <WatchupProvider
      apiKey={process.env.NEXT_PUBLIC_WATCHUP_API_KEY}
      options={{
        environment: process.env.NODE_ENV,
        release: process.env.NEXT_PUBLIC_GIT_SHA,
        logging: { enabled: true, captureConsole: true, minLevel: "info" },
      }}
    >
      {children}
    </WatchupProvider>
  );
}
`;
}

function instrumentationSource() {
  return `import { registerWatchup } from "@watchupltd/nextjs/server";

// Next.js calls register() once per runtime; WatchUp runs on the Node.js runtime.
export function register() {
  registerWatchup({
    apiKey: process.env.WATCHUP_API_KEY,
    release: process.env.NEXT_PUBLIC_GIT_SHA,
    logging: { enabled: true, minLevel: "info" },
  });
}

// Next.js 15+: report errors from Server Components, Route Handlers and Server Actions.
export { captureRequestError as onRequestError } from "@watchupltd/nextjs/server";
`;
}

/** Keys go only where they belong: public key → NEXT_PUBLIC_, secret key → server var. */
function envEntries(apiKey) {
  const kind = keyKind(apiKey);
  return {
    NEXT_PUBLIC_WATCHUP_API_KEY: kind === "public" ? apiKey : PLACEHOLDER_PUBLIC,
    WATCHUP_API_KEY: kind === "secret" ? apiKey : PLACEHOLDER_SECRET,
  };
}

async function installNext({ cwd, apiKey }) {
  const created = [];
  const notes = [];
  const appDir = fs.existsSync(path.join(cwd, "app")) ? "app" : "src/app";
  const providerPath = path.join(cwd, appDir, "components", "WatchupInit.jsx");
  const layoutPath = findFirst(cwd, ["layout.tsx", "layout.jsx", "layout.js"].map((f) => path.join(appDir, f)));
  const instrumentationFiles = ["instrumentation.ts", "instrumentation.js", "src/instrumentation.ts", "src/instrumentation.js"];
  const existingInstrumentation = findFirst(cwd, instrumentationFiles);

  if (writeFileIfMissing(providerPath, providerSource())) created.push(path.relative(cwd, providerPath));

  if (!existingInstrumentation) {
    const target = path.join(cwd, appDir.startsWith("src/") ? "src/instrumentation.js" : "instrumentation.js");
    if (writeFileIfMissing(target, instrumentationSource())) created.push(path.relative(cwd, target));
  } else if (!alreadyMentions(cwd, [path.relative(cwd, existingInstrumentation)], "@watchupltd/nextjs")) {
    notes.push(
      `${path.relative(cwd, existingInstrumentation)} already exists: add registerWatchup() from "@watchupltd/nextjs/server" to its register() function.`,
    );
  }

  if (layoutPath) {
    if (patchLayout(layoutPath)) created.push(path.relative(cwd, layoutPath));
  } else {
    notes.push(`Wrap your root layout's children with <WatchupInit> from "./components/WatchupInit" in ${appDir}/layout.`);
  }

  if (appendEnv(cwd, envEntries(apiKey))) created.push(".env.local");
  if (keyKind(apiKey) !== "secret") notes.push("Set WATCHUP_API_KEY in .env.local to your secret wup_live_ key for server-side monitoring.");
  if (keyKind(apiKey) !== "public") notes.push("Set NEXT_PUBLIC_WATCHUP_API_KEY in .env.local to your public wup_pub_ key for browser monitoring.");

  return {
    packages: ["@watchupltd/nextjs", "@watchupltd/browser", "@watchupltd/react", "@watchupltd/node"],
    created,
    notes,
  };
}

function patchLayout(layoutPath) {
  let source = fs.readFileSync(layoutPath, "utf8");
  // Never add a second provider.
  if (source.includes("WatchupInit") || source.includes("WatchupProvider")) return false;

  const bodyOpen = /<body([^>]*)>/;
  if (!bodyOpen.test(source) || !source.includes("{children}")) return false;

  source = `import WatchupInit from "./components/WatchupInit";\n${source}`;
  source = source.replace("{children}", "<WatchupInit>{children}</WatchupInit>");
  fs.writeFileSync(layoutPath, source, "utf8");
  return true;
}

module.exports = { installNext, envEntries };
