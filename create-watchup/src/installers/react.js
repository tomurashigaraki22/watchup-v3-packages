const path = require("node:path");
const { appendEnv, assertPublicKey, writeFileIfMissing, PLACEHOLDER_PUBLIC } = require("./utils");

function source() {
  return `import { WatchupProvider } from "@watchupltd/react";

export default function WatchupInit({ children }) {
  return (
    <WatchupProvider
      apiKey={import.meta.env.VITE_WATCHUP_API_KEY}
      options={{
        environment: import.meta.env.MODE,
        logging: { enabled: true, captureConsole: true, minLevel: "info" },
      }}
    >
      {children}
    </WatchupProvider>
  );
}
`;
}

async function installReact({ cwd, apiKey }) {
  assertPublicKey(apiKey, "VITE_WATCHUP_API_KEY");
  const filePath = path.join(cwd, "src", "watchup.jsx");
  const created = [];
  const notes = [];
  if (writeFileIfMissing(filePath, source())) {
    created.push(path.relative(cwd, filePath));
    notes.push("Wrap your React root with <WatchupInit> from src/watchup.jsx.");
  } else {
    notes.push("src/watchup.jsx already exists, so it was left unchanged.");
  }
  if (appendEnv(cwd, { VITE_WATCHUP_API_KEY: apiKey || PLACEHOLDER_PUBLIC })) created.push(".env.local");

  return { packages: ["@watchupltd/react", "@watchupltd/browser"], created, notes };
}

module.exports = { installReact };
