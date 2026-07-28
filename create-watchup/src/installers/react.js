const path = require("path");
const { appendEnv, writeFileIfMissing } = require("./utils");

function source() {
  return `import { WatchupProvider } from "@watchupltd/react";

export default function WatchupInit({ children }) {
  return (
    <WatchupProvider
      apiKey={import.meta.env.VITE_WATCHUP_API_KEY}
      options={{
        flushInterval: 5000,
        maxBatchSize: 25,
        autoCapture: { errors: true, performance: true, pageViews: true },
        logging: {
          enabled: true,
          captureConsole: true,
          includeDeviceContext: true,
          minLevel: "debug",
        },
      }}
    >
      {children}
    </WatchupProvider>
  );
}
`;
}

async function installReact({ cwd, apiKey }) {
  const filePath = path.join(cwd, "src", "watchup.jsx");
  const created = [];
  if (writeFileIfMissing(filePath, source())) created.push(path.relative(cwd, filePath));
  if (appendEnv(cwd, { VITE_WATCHUP_API_KEY: apiKey || "wup_pub_xxx" })) created.push(".env.local");

  return {
    packages: ["@watchupltd/react", "@watchupltd/browser"],
    created,
    notes: ["Wrap your React root with <WatchupInit> from src/watchup.jsx."],
  };
}

module.exports = { installReact };
