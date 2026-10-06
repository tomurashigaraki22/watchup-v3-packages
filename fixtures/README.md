# Consumer fixtures

Small apps that install the SDKs from `npm pack` tarballs — exactly what a
user gets from the registry — and build them. CI runs each one (see the
`fixtures` job in `.github/workflows/ci.yml`). Locally:

```bash
npm run build
npm pack -w browser -w react -w nextjs -w node -w svelte -w react-native --pack-destination /tmp/watchup-pkgs
cd fixtures/next-app
npm install next@15 react@19 react-dom@19 typescript@5 @types/react@19 @types/node /tmp/watchup-pkgs/*.tgz
NEXT_PUBLIC_WATCHUP_API_KEY=wup_pub_fixture WATCHUP_API_KEY=wup_live_secret npx next build
node ../../tools/scan-build-secrets.mjs .next/static wup_live_secret
```

| Fixture | Proves |
| --- | --- |
| `next-app` | Next 14 and 15, App Router and Pages Router, `registerWatchup`, `onRequestError`, no server key in `.next/static`; webpack, and Turbopack on Next 15 |
| `vite-react` | React 18 and 19 with Vite, StrictMode, error boundary |
| `sveltekit` | SvelteKit server and client hooks, the SSR-safe provider, Svelte 4 and 5 |
| `expo-app` | Expo managed-workflow export |
| `react-native-bare` | Bare React Native Metro bundle compiled by Hermes |

Generated `node_modules`, `.next`, `dist` and `out` folders are git-ignored.
