# create-watchup

Set up WatchUp in an existing JavaScript project.

```bash
npx create-watchup@latest
npx create-watchup@latest next --api-key wup_pub_xxx --yes
npx create-watchup@latest express --api-key wup_live_xxx
```

The CLI detects the framework, checks that the packages it needs are published, installs them, writes the environment variable(s) and creates one integration file. Running it again never adds a second provider, middleware or environment entry.

| Framework | Installs | Writes |
| --- | --- | --- |
| `next` | `@watchupltd/nextjs`, `browser`, `react`, `node` | `app/components/WatchupInit.jsx` (wired into your root layout), `instrumentation.js`, `.env.local` |
| `react` (Vite) | `@watchupltd/react`, `browser` | `src/watchup.jsx`, `.env.local` |
| `react-native` / Expo | `@watchupltd/react-native` | `src/watchup.jsx`, `.env.local` |
| `svelte` (SvelteKit) | `@watchupltd/svelte`, `browser`, `node` | `src/hooks.server.js`, `.env` |
| `node` / `express` | `@watchupltd/node` | `watchup.js`, `.env` |

## Keys go only where they belong

- A public `wup_pub_` key is written only to the browser variable (`NEXT_PUBLIC_…`, `VITE_…`, `EXPO_PUBLIC_…`, `PUBLIC_…`).
- A secret `wup_live_` key is written only to the server variable (`WATCHUP_API_KEY`). Browser-only frameworks refuse it.
- The variable you didn't provide gets a placeholder and a note.

## Unsupported projects fail fast

Python, Go and .NET projects (and Vue, Nuxt, Angular, Solid, Astro, Remix) stop with the right next step — for example `pip install watchup` — instead of installing an npm package that does not apply.

## Options

| Option | Description |
| --- | --- |
| `--api-key <key>` | WatchUp key (public or secret, see above). |
| `--yes`, `-y` | Skip prompts (fails if the framework can't be detected). |
| `--no-install` | Write files only. |
| `--skip-verify` | Don't check that packages are published before installing. |

## License

MIT © Watchup Ltd
