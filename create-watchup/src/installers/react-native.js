const path = require("path");
const { appendEnv, writeFileIfMissing } = require("./utils");

function source() {
  return `import { WatchupProvider } from "@watchupltd/react-native";

export default function WatchupInit({ children }) {
  return (
    <WatchupProvider
      apiKey={process.env.EXPO_PUBLIC_WATCHUP_API_KEY}
      options={{
        environment: process.env.NODE_ENV,
        release: process.env.EXPO_PUBLIC_GIT_SHA,
        flushInterval: 5000,
        maxBatchSize: 25,
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

async function installReactNative({ cwd, apiKey }) {
  const filePath = path.join(cwd, "src", "watchup.jsx");
  const created = [];
  if (writeFileIfMissing(filePath, source())) created.push(path.relative(cwd, filePath));
  if (appendEnv(cwd, { EXPO_PUBLIC_WATCHUP_API_KEY: apiKey || "wup_pub_xxx" })) created.push(".env.local");

  return {
    packages: ["@watchupltd/react-native"],
    created,
    notes: ["Wrap your Expo or React Native root with <WatchupInit> from src/watchup.jsx."],
  };
}

module.exports = { installReactNative };
