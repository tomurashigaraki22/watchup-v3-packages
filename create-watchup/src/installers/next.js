const fs = require("fs");
const path = require("path");
const { appendEnv, writeFileIfMissing } = require("./utils");

function providerSource() {
  return `"use client";

import dynamic from "next/dynamic";

const WatchupProvider = dynamic(
  () => import("@watchupltd/nextjs/client").then((m) => m.WatchupProvider),
  { ssr: false }
);

export default function WatchupInit({ children }) {
  return (
    <WatchupProvider
      apiKey={process.env.NEXT_PUBLIC_WATCHUP_API_KEY}
      options={{
        environment: process.env.NODE_ENV,
        release: process.env.NEXT_PUBLIC_GIT_SHA,
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

function instrumentationSource() {
  return `export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initWatchup } = await import("@watchupltd/nextjs/server");
    initWatchup({
      apiKey: process.env.WATCHUP_API_KEY,
      environment: process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_GIT_SHA,
      logging: { enabled: true, minLevel: "info" },
    });
  }
}
`;
}

async function installNext({ cwd, apiKey }) {
  const created = [];
  const appDir = fs.existsSync(path.join(cwd, "app")) ? "app" : "src/app";
  const componentsDir = path.join(cwd, appDir, "components");
  const providerPath = path.join(componentsDir, "WatchupInit.jsx");
  const instrumentationPath = path.join(cwd, "instrumentation.js");
  const layoutPath = ["layout.js", "layout.jsx", "layout.tsx"]
    .map((file) => path.join(cwd, appDir, file))
    .find((file) => fs.existsSync(file));

  if (writeFileIfMissing(providerPath, providerSource())) created.push(path.relative(cwd, providerPath));
  if (writeFileIfMissing(instrumentationPath, instrumentationSource())) created.push(path.relative(cwd, instrumentationPath));
  if (layoutPath && patchLayout(layoutPath)) created.push(path.relative(cwd, layoutPath));
  if (appendEnv(cwd, {
    NEXT_PUBLIC_WATCHUP_API_KEY: apiKey || "wup_pub_xxx",
    WATCHUP_API_KEY: apiKey || "wup_live_xxx",
  })) created.push(".env.local");

  return {
    packages: ["@watchupltd/nextjs", "@watchupltd/browser", "@watchupltd/react", "@watchupltd/node"],
    created,
    notes: [
      layoutPath
        ? "Your App Router layout was wrapped with <WatchupInit>."
        : `Wrap your app layout children with <WatchupInit> from "./components/WatchupInit" inside ${appDir}/layout.js or ${appDir}/layout.jsx.`,
    ],
  };
}

function patchLayout(layoutPath) {
  let source = fs.readFileSync(layoutPath, "utf8");
  if (source.includes("WatchupInit")) return false;

  source = `import WatchupInit from "./components/WatchupInit";\n${source}`;

  const bodyOpen = /<body([^>]*)>/;
  if (!bodyOpen.test(source) || !source.includes("{children}")) {
    fs.writeFileSync(layoutPath, source, "utf8");
    return true;
  }

  source = source.replace(bodyOpen, "<body$1>\n        <WatchupInit>");
  source = source.replace("{children}", "{children}\n        </WatchupInit>");
  fs.writeFileSync(layoutPath, source, "utf8");
  return true;
}

module.exports = { installNext };
