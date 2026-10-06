const path = require("node:path");
const { appendEnv, assertPublicKey, writeFileIfMissing, PLACEHOLDER_PUBLIC } = require("./utils");

function source() {
  return `import { WatchupProvider } from "@watchupltd/react-native";

export default function WatchupInit({ children }) {
  return (
    <WatchupProvider
      apiKey={process.env.EXPO_PUBLIC_WATCHUP_API_KEY}
      options={{
        environment: process.env.NODE_ENV,
        release: process.env.EXPO_PUBLIC_GIT_SHA,
        logging: { enabled: true, minLevel: "info" },
      }}
    >
      {children}
    </WatchupProvider>
  );
}
`;
}

async function installReactNative({ cwd, apiKey }) {
  assertPublicKey(apiKey, "EXPO_PUBLIC_WATCHUP_API_KEY");
  const filePath = path.join(cwd, "src", "watchup.jsx");
  const created = [];
  const notes = [];
  if (writeFileIfMissing(filePath, source())) {
    created.push(path.relative(cwd, filePath));
    notes.push("Wrap your Expo or React Native root with <WatchupInit> from src/watchup.jsx.");
  } else {
    notes.push("src/watchup.jsx already exists, so it was left unchanged.");
  }
  if (appendEnv(cwd, { EXPO_PUBLIC_WATCHUP_API_KEY: apiKey || PLACEHOLDER_PUBLIC })) created.push(".env.local");
  notes.push("Optional: install @react-native-async-storage/async-storage and @react-native-community/netinfo for offline delivery.");

  return { packages: ["@watchupltd/react-native"], created, notes };
}

module.exports = { installReactNative };
