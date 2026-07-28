# create-watchup

Set up WatchUp in an existing project.

```bash
npx create-watchup@latest
npx create-watchup@latest next --api-key wup_pub_xxx --yes
npx create-watchup@latest express --api-key wup_live_xxx
```

The CLI detects the project framework when no framework is provided. It installs the related WatchUp package and creates safe setup files you can import from your app.

Supported targets:

- `next`
- `react`
- `node`
- `express`

Options:

- `--api-key <key>`: WatchUp project API key.
- `--yes`: skip confirmation prompts.
- `--no-install`: write files without installing packages.
- `--with-logs`: enable live logs. Enabled by default.
