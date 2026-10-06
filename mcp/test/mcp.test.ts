import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createWatchupServer, envFromProcess, MAX_OUTPUT_CHARS, type McpEnv } from '../src/server.js';
import { toolSchema } from '../src/schema.js';

type FetchMock = ReturnType<typeof vi.fn>;

async function connect(env: Partial<McpEnv>, responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock: FetchMock = vi.fn(async (url: string, init: RequestInit) => responder(url, init));
  const logs: Array<Record<string, unknown>> = [];
  const server = createWatchupServer({
    env: { ...envFromProcess({}), apiUrl: 'https://api.test', ...env },
    fetch: fetchMock as unknown as typeof fetch,
    log: (entry) => logs.push(entry),
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = result.content[0]!.text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: Boolean(result.isError), text, json: json as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  return { client, call, fetchMock, logs };
}

const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });

describe('protocol', () => {
  it('completes the handshake and lists every tool', async () => {
    const { client } = await connect({ token: 't' }, () => ok({}));
    expect(client.getServerVersion()).toMatchObject({ name: 'watchup', version: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('watchup_list_errors');
    expect(tools).toHaveLength(21); // 18 read + 3 write tools
  });

  it('matches the committed, versioned tool schema', async () => {
    const committed = JSON.parse(readFileSync(new URL('../tool-schema.json', import.meta.url), 'utf8'));
    expect(await toolSchema()).toEqual(committed);
  });
});

describe('authorization', () => {
  it('requires a credential for reads', async () => {
    const { call } = await connect({}, () => ok({}));
    const r = await call('watchup_list_projects');
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/WATCHUP_TOKEN or WATCHUP_PROJECT_API_KEY/);
  });

  it('never lets a project API key write, even with read-only disabled', async () => {
    const { call, fetchMock } = await connect({ projectApiKey: 'wup_pub_x', readOnly: false }, () => ok({}));
    const r = await call('watchup_create_feature_flag', { project_id: 'p1', key: 'beta', name: 'Beta' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/dedicated MCP token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks writes in read-only mode and allows them with a token when enabled', async () => {
    const readOnly = await connect({ token: 'tok', readOnly: true }, () => ok({}));
    expect((await readOnly.call('watchup_create_bug_report', { title: 'Broken', body: 'It is broken badly' })).isError).toBe(true);

    const writable = await connect({ token: 'tok', readOnly: false, defaultProjectId: 'p1' }, () => ok({ id: 7 }));
    const r = await writable.call('watchup_create_feature_flag', { key: 'beta', name: 'Beta' });
    expect(r.isError).toBe(false);
    const [url, init] = writable.fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/api/v1/projects/p1/flags');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('requires and validates project_id', async () => {
    const { call } = await connect({ token: 't' }, () => ok({}));
    expect((await call('watchup_list_errors')).text).toMatch(/project_id is required/);
    expect((await call('watchup_list_errors', { project_id: '../admin' })).text).toMatch(/invalid characters/);
  });

  it('explains 401/403 responses', async () => {
    const { call } = await connect({ token: 't' }, () => new Response(JSON.stringify({ ok: false, error: 'Forbidden' }), { status: 403 }));
    expect((await call('watchup_get_project', { project_id: 'p1' })).text).toMatch(/403: Forbidden\. Check that the token can access this project/);
  });
});

describe('output safety', () => {
  it('redacts secrets in API responses and error messages', async () => {
    const data = { channels: [{ type: 'webhook', url: 'https://hooks.test/x?token=abc123', secret: 's3cr3t', api_key: 'k' }] };
    const { call } = await connect({ token: 't' }, () => ok(data));
    const r = await call('watchup_list_errors', { project_id: 'p1' });
    expect(r.text).not.toContain('s3cr3t');
    expect(r.text).not.toContain('abc123');

    const failing = await connect({ token: 't' }, () => new Response(JSON.stringify({ ok: false, error: 'bad key wup_live_abcdef123' }), { status: 400 }));
    const e = await failing.call('watchup_get_project', { project_id: 'p1' });
    expect(e.text).not.toContain('wup_live_abcdef123');
  });

  it('paginates and caps output size', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: i, message: 'x'.repeat(500) }));
    const { call, fetchMock } = await connect({ token: 't' }, () => ok({ errors: rows }));
    const r = await call('watchup_list_errors', { project_id: 'p1', limit: 10 });
    expect(r.json.errors).toHaveLength(10);
    expect(r.json._pagination).toMatchObject({ has_more: true, next_page: 2 });
    expect(String(fetchMock.mock.calls[0]![0])).toContain('limit=10');

    const big = await call('watchup_list_errors', { project_id: 'p1', limit: 200 });
    expect(big.text.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS + 200);
    expect(big.text).toContain('output truncated');
  });
});

describe('failures and diagnostics', () => {
  it('reports timeouts clearly', async () => {
    const { call } = await connect({ token: 't', timeoutMs: 20 }, (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      }),
    );
    expect((await call('watchup_list_projects')).text).toMatch(/timed out after 0s|timed out/);
  });

  it('reports network failures and partial alert channel failures', async () => {
    const down = await connect({ token: 't' }, () => {
      throw new TypeError('fetch failed');
    });
    expect((await down.call('watchup_list_projects')).text).toMatch(/Could not reach the WatchUp API/);

    const partial = await connect({ token: 't' }, (url) =>
      url.includes('/slack') ? new Response('{"ok":false,"error":"nope"}', { status: 404 }) : ok({ enabled: true }),
    );
    const r = await partial.call('watchup_list_alert_channels', { project_id: 'p1' });
    expect(r.json.channels.find((c: { type: string }) => c.type === 'slack').ok).toBe(false);
    expect(r.json.channels.find((c: { type: string }) => c.type === 'email').ok).toBe(true);
  });

  it('emits diagnostics without tokens or arguments', async () => {
    const { call, logs } = await connect({ token: 'super-secret-token', logLevel: 'info' }, () => new Response('{"ok":false,"error":"x"}', { status: 500 }));
    await call('watchup_list_errors', { project_id: 'p1', limit: 5 });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'tool_call', tool: 'watchup_list_errors', ok: false });
    expect(JSON.stringify(logs)).not.toContain('super-secret-token');
    expect(JSON.stringify(logs)).not.toContain('p1');
  });
});

describe('client configuration examples', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  it('Claude Desktop / Cursor JSON is valid and launches the package', () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(readme)![1]!;
    const config = JSON.parse(json);
    expect(config.mcpServers.watchup).toMatchObject({ command: 'npx', args: ['-y', '@watchupltd/mcp'] });
    expect(config.mcpServers.watchup.env.WATCHUP_READ_ONLY).toBe('true');
  });

  it('Codex TOML and Claude Code commands launch the package', () => {
    const toml = /```toml\n([\s\S]*?)\n```/.exec(readme)![1]!;
    expect(toml).toMatch(/^\[mcp_servers\.watchup\]$/m);
    expect(toml).toContain('args = ["-y", "@watchupltd/mcp"]');
    expect(readme).toContain('claude mcp add watchup');
  });
});
