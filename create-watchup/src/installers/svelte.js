const path = require("node:path");
const { appendEnv, assertPublicKey, findFirst, writeFileIfMissing, PLACEHOLDER_PUBLIC, PLACEHOLDER_SECRET } = require("./utils");

function hooksServerSource() {
  return `import { env } from "$env/dynamic/private";
import { Watchup } from "@watchupltd/node";
import { watchupHandle, watchupHandleError } from "@watchupltd/svelte/server";

const watchup = new Watchup({ apiKey: env.WATCHUP_API_KEY ?? "", environment: env.NODE_ENV });

export const handle = watchupHandle(watchup);
export const handleError = watchupHandleError(watchup);
`;
}

async function installSvelte({ cwd, apiKey }) {
  assertPublicKey(apiKey, "PUBLIC_WATCHUP_API_KEY");
  const created = [];
  const notes = [
    "In src/routes/+layout.svelte, import WatchupProvider from '@watchupltd/svelte/WatchupProvider.svelte' and wrap <slot /> with <WatchupProvider apiKey={PUBLIC_WATCHUP_API_KEY}> (import PUBLIC_WATCHUP_API_KEY from '$env/static/public').",
  ];

  const existingHooks = findFirst(cwd, ["src/hooks.server.ts", "src/hooks.server.js"]);
  if (existingHooks) {
    notes.push(`${path.relative(cwd, existingHooks)} already exists: add watchupHandle/watchupHandleError from '@watchupltd/svelte/server' (use sequence() if you already export handle).`);
  } else if (writeFileIfMissing(path.join(cwd, "src", "hooks.server.js"), hooksServerSource())) {
    created.push("src/hooks.server.js");
  }

  if (appendEnv(cwd, { PUBLIC_WATCHUP_API_KEY: apiKey || PLACEHOLDER_PUBLIC, WATCHUP_API_KEY: PLACEHOLDER_SECRET }, ".env")) {
    created.push(".env");
  }
  notes.push("Set WATCHUP_API_KEY in .env to your secret wup_live_ key for server-side monitoring.");

  return { packages: ["@watchupltd/svelte", "@watchupltd/browser", "@watchupltd/node"], created, notes };
}

module.exports = { installSvelte };
