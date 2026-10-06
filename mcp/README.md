# WatchUp MCP

`@watchupltd/mcp` connects MCP-compatible AI assistants to WatchUp production context: projects, errors, logs, traces, alerts, endpoints, databases, flags and community posts.

The server runs locally over stdio and calls the WatchUp API with your token. It doesn't connect to your database, doesn't store telemetry, and doesn't bypass WatchUp permissions.

## Configure your client

All clients run the same command: `npx -y @watchupltd/mcp`.

**Claude Desktop** (`claude_desktop_config.json`) and **Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "watchup": {
      "command": "npx",
      "args": ["-y", "@watchupltd/mcp"],
      "env": {
        "WATCHUP_TOKEN": "watchup_pat_xxx",
        "WATCHUP_DEFAULT_PROJECT_ID": "your-project-id",
        "WATCHUP_READ_ONLY": "true"
      }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add watchup -e WATCHUP_TOKEN=watchup_pat_xxx -- npx -y @watchupltd/mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.watchup]
command = "npx"
args = ["-y", "@watchupltd/mcp"]
env = { WATCHUP_TOKEN = "watchup_pat_xxx", WATCHUP_READ_ONLY = "true" }
```

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `WATCHUP_TOKEN` | — | Dedicated MCP or personal token. **Required for write tools.** |
| `WATCHUP_PROJECT_API_KEY` | — | Project API key fallback. Always read-only. |
| `WATCHUP_DEFAULT_PROJECT_ID` | — | Used when a tool call omits `project_id`. |
| `WATCHUP_READ_ONLY` | `true` | Set to `false` (with `WATCHUP_TOKEN`) to enable write tools. |
| `WATCHUP_API_URL` | `https://api.watchup.site` | Self-hosted API URL. |
| `WATCHUP_TIMEOUT_MS` | `15000` | Per-request timeout. |
| `WATCHUP_MCP_LOG` | `warn` | stderr diagnostics: `debug`, `info`, `warn` or `off`. JSON lines; never includes tokens or tool arguments. |

## Tools

Read: `watchup_health`, `watchup_list_projects`, `watchup_get_project`, `watchup_get_overview`, `watchup_list_errors`, `watchup_list_events`, `watchup_list_logs`, `watchup_list_traces`, `watchup_list_alerts`, `watchup_list_alert_channels`, `watchup_list_web_analytics`, `watchup_list_endpoints`, `watchup_list_databases`, `watchup_list_server_agents`, `watchup_list_feature_flags`, `watchup_list_community_posts`, `watchup_list_roadmap`, `watchup_list_shipped`.

Write (need `WATCHUP_TOKEN` and `WATCHUP_READ_ONLY=false`): `watchup_create_community_post`, `watchup_create_bug_report`, `watchup_create_feature_flag`.

List tools take `limit` (default 50, max 200) and `page`, and return `has_more`/`next_page`. Output is capped at 60 000 characters.

The tool schema is versioned: `npx @watchupltd/mcp --print-schema` prints it, and [`tool-schema.json`](./tool-schema.json) is the published copy (`schema_version` bumps its major number when a tool or argument is removed).

## Security

- Every response and error message is redacted before it reaches the assistant (tokens, secrets, passwords, card numbers, `wup_live_` keys).
- Use a dedicated token for MCP. Never commit tokens. Keep `WATCHUP_READ_ONLY=true` unless you deliberately want the assistant to create posts, bug reports or feature flags.
- A project API key can never write, whatever `WATCHUP_READ_ONLY` says.

## Compatibility

Tested with MCP SDK 1.x clients over stdio (protocol handshake, `tools/list`, `tools/call`). See [`docs/COMPATIBILITY.md`](../docs/COMPATIBILITY.md) for the client matrix.

## License

MIT © Watchup Ltd
