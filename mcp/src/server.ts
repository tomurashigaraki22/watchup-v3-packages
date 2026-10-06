// ─────────────────────────────────────────────────────────────────────────────
// @watchupltd/mcp  ·  server factory
//
// Read tools work with a dedicated token or a project API key. Write tools
// need a dedicated token (WATCHUP_TOKEN) *and* WATCHUP_READ_ONLY=false; a
// project API key is never allowed to write. All tool output is redacted,
// paginated and size-capped, and every API call has a timeout. Diagnostics go
// to stderr as JSON lines and never include tokens or tool arguments.
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { normalize, scrubString } from '@watchupltd/core';
import { SDK_NAME, SDK_VERSION } from './version.js';

export const DEFAULT_API_URL = 'https://api.watchup.site';
/** Tool output larger than this is truncated (MCP clients feed it to a model). */
export const MAX_OUTPUT_CHARS = 60_000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

export interface McpEnv {
  apiUrl: string;
  token: string;
  projectApiKey: string;
  defaultProjectId: string;
  readOnly: boolean;
  timeoutMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'off';
}

export function envFromProcess(source: Record<string, string | undefined> = process.env): McpEnv {
  const level = source.WATCHUP_MCP_LOG;
  return {
    apiUrl: (source.WATCHUP_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
    token: source.WATCHUP_TOKEN || '',
    projectApiKey: source.WATCHUP_PROJECT_API_KEY || source.WATCHUP_API_KEY || '',
    defaultProjectId: source.WATCHUP_DEFAULT_PROJECT_ID || '',
    readOnly: source.WATCHUP_READ_ONLY !== 'false',
    timeoutMs: Number(source.WATCHUP_TIMEOUT_MS) > 0 ? Number(source.WATCHUP_TIMEOUT_MS) : 15_000,
    logLevel: level === 'debug' || level === 'info' || level === 'off' ? level : 'warn',
  };
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface ServerDeps {
  env: McpEnv;
  fetch?: typeof fetch;
  /** Diagnostic sink; defaults to JSON lines on stderr. */
  log?: (entry: Record<string, unknown>) => void;
}

const LEVELS = { debug: 10, info: 20, warn: 30, off: 99 } as const;

export function createWatchupServer({ env, fetch: fetchImpl = fetch, log }: ServerDeps): McpServer {
  const emit = (level: 'debug' | 'info' | 'warn', entry: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[env.logLevel]) return;
    const line = { ts: new Date().toISOString(), level, ...entry };
    if (log) log(line);
    else process.stderr.write(`${JSON.stringify(line)}\n`);
  };

  // ── Auth guards ────────────────────────────────────────────────────────────

  const credential = () => env.token || env.projectApiKey;

  const assertReadable = () => {
    if (!credential()) {
      throw new Error(
        'WATCHUP_TOKEN or WATCHUP_PROJECT_API_KEY is required. Set one in your MCP client environment before starting @watchupltd/mcp.',
      );
    }
  };

  const assertWritable = () => {
    if (!env.token) {
      throw new Error(
        'Write tools need a dedicated MCP token in WATCHUP_TOKEN. Project API keys are read-only in WatchUp MCP.',
      );
    }
    if (env.readOnly) {
      throw new Error('This WatchUp MCP server is running in read-only mode. Set WATCHUP_READ_ONLY=false to enable write tools.');
    }
  };

  const projectId = (value?: string) => {
    const resolved = value || env.defaultProjectId;
    if (!resolved) {
      throw new Error('A project_id is required. Pass project_id to this tool or set WATCHUP_DEFAULT_PROJECT_ID.');
    }
    if (!/^[\w-]{1,64}$/.test(resolved)) throw new Error('project_id contains invalid characters.');
    return encodeURIComponent(resolved);
  };

  // ── API client ─────────────────────────────────────────────────────────────

  const query = (params: Record<string, string | number | boolean | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    assertReadable();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${credential()}`);
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', `${SDK_NAME}/${SDK_VERSION}`);
    if (init.body) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await fetchImpl(`${env.apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(env.timeoutMs) });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new Error(`WatchUp API timed out after ${Math.round(env.timeoutMs / 1000)}s.`);
      }
      throw new Error(`Could not reach the WatchUp API: ${err instanceof Error ? err.message : String(err)}`);
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    const apiError = (p: unknown) =>
      p && typeof p === 'object' && 'error' in p ? String((p as { error: unknown }).error) : undefined;

    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? ' Check that the token can access this project.' : '';
      throw new Error(`WatchUp API ${response.status}: ${apiError(payload) ?? response.statusText}.${hint}`);
    }
    if (payload && typeof payload === 'object' && (payload as { ok?: unknown }).ok === false) {
      throw new Error(apiError(payload) ?? 'Unknown API error');
    }
    if (payload && typeof payload === 'object' && 'data' in payload) return (payload as { data: unknown }).data;
    return payload;
  };

  const get = (path: string) => request(path, { method: 'GET' });
  const post = (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) });

  // ── Output shaping ─────────────────────────────────────────────────────────

  /** Keep at most `limit` items of the main list in a response. */
  const paginate = (data: unknown, limit: number, page: number): unknown => {
    const cut = (list: unknown[]) => ({
      items: list.slice(0, limit),
      page,
      returned: Math.min(list.length, limit),
      ...(list.length > limit && { has_more: true, next_page: page + 1 }),
    });
    if (Array.isArray(data)) return cut(data);
    if (data && typeof data === 'object') {
      const entries = Object.entries(data as Record<string, unknown>);
      const arrays = entries.filter(([, v]) => Array.isArray(v));
      if (arrays.length === 1) {
        const [key, list] = arrays[0]!;
        const { items, ...meta } = cut(list as unknown[]);
        return { ...(data as Record<string, unknown>), [key]: items, _pagination: meta };
      }
    }
    return data;
  };

  const render = (data: unknown): ToolResult => {
    const safe = normalize(data);
    let text = JSON.stringify(safe, null, 2) ?? 'null';
    if (text.length > MAX_OUTPUT_CHARS) {
      text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [output truncated at ${MAX_OUTPUT_CHARS} characters; use limit/page to narrow the request]`;
    }
    return { content: [{ type: 'text', text }] };
  };

  const failure = (error: unknown): ToolResult => ({
    isError: true,
    content: [{ type: 'text', text: scrubString(error instanceof Error ? error.message : String(error)) }],
  });

  const run = async (tool: string, handler: () => Promise<unknown>): Promise<ToolResult> => {
    const start = Date.now();
    try {
      const result = render(await handler());
      emit('info', { event: 'tool_call', tool, ok: true, duration_ms: Date.now() - start });
      return result;
    } catch (error) {
      emit('warn', {
        event: 'tool_call',
        tool,
        ok: false,
        duration_ms: Date.now() - start,
        error: scrubString(error instanceof Error ? error.message : String(error)),
      });
      return failure(error);
    }
  };

  // ── Tools ──────────────────────────────────────────────────────────────────

  const server = new McpServer({ name: 'watchup', version: SDK_VERSION });

  const projectArg = { project_id: z.string().optional().describe('Project ID. Defaults to WATCHUP_DEFAULT_PROJECT_ID.') };
  const pageArgs = {
    limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`Max items to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
    page: z.number().int().min(1).optional().describe('1-based page number.'),
  };
  const rangeArg = { range: z.enum(['1h', '24h', '7d', '30d']).optional().describe('Time window (default 24h).') };

  server.tool('watchup_health', 'Check whether the WatchUp MCP server is configured and ready.', {}, async () =>
    render({
      ok: Boolean(credential()),
      api_url: env.apiUrl,
      auth_mode: env.token ? 'mcp_token' : env.projectApiKey ? 'project_api_key' : 'none',
      default_project_id: env.defaultProjectId || null,
      read_only: env.readOnly || !env.token,
      package: SDK_NAME,
      version: SDK_VERSION,
    }),
  );

  server.tool('watchup_list_projects', 'List WatchUp projects available to the token.', { ...pageArgs }, async ({ limit, page }) =>
    run('watchup_list_projects', async () => paginate(await get('/api/v1/projects'), limit ?? DEFAULT_LIMIT, page ?? 1)),
  );

  server.tool('watchup_get_project', 'Fetch metadata and health information for a WatchUp project.', { ...projectArg }, async ({ project_id }) =>
    run('watchup_get_project', () => get(`/api/v1/projects/${projectId(project_id)}`)),
  );

  server.tool(
    'watchup_get_overview',
    'Fetch the project overview: health, throughput, latency, recent activity, and readiness state.',
    { ...projectArg },
    async ({ project_id }) => run('watchup_get_overview', () => get(`/api/v1/projects/${projectId(project_id)}/overview`)),
  );

  const listTool = (name: string, description: string, path: string, extra: Record<string, z.ZodTypeAny> = {}) =>
    server.tool(name, description, { ...projectArg, ...pageArgs, ...extra }, async (args: Record<string, unknown>) =>
      run(name, async () => {
        const limit = (args.limit as number | undefined) ?? DEFAULT_LIMIT;
        const page = (args.page as number | undefined) ?? 1;
        const params: Record<string, string | number | undefined> = { limit, page };
        for (const key of Object.keys(extra)) params[key] = args[key] as string | undefined;
        const data = await get(`/api/v1/projects/${projectId(args.project_id as string | undefined)}/${path}${query(params)}`);
        return paginate(data, limit, page);
      }),
    );

  listTool('watchup_list_errors', 'List recent captured errors and error groups for a project.', 'errors');
  listTool('watchup_list_events', 'List recent project events, including SDK log events.', 'events');
  listTool('watchup_list_logs', 'List structured Live logs entries for a project.', 'logs');
  listTool('watchup_list_traces', 'List recent request traces and latency context for a project.', 'traces');
  listTool('watchup_list_feature_flags', 'List feature flags and rollout state for a project.', 'flags');
  listTool('watchup_list_web_analytics', 'Fetch web analytics for a project.', 'web-analytics', { ...rangeArg });
  listTool('watchup_list_endpoints', 'List endpoint performance and request metrics for a project.', 'endpoints', {
    ...rangeArg,
    trace_type: z.string().max(32).optional().describe('Filter by trace type (http, db, function, custom).'),
  });
  listTool('watchup_list_databases', 'List database monitors and their latest health metrics for a project.', 'databases');
  listTool('watchup_list_server_agents', 'List server agents and infrastructure health for a project.', 'agents');

  server.tool('watchup_list_alerts', 'List alert rules and incidents for a project.', { ...projectArg, ...pageArgs }, async ({ project_id, limit, page }) =>
    run('watchup_list_alerts', async () => {
      const id = projectId(project_id);
      const [rules, incidents] = await Promise.all([get(`/api/v1/projects/${id}/alert-rules`), get(`/api/v1/projects/${id}/incidents`)]);
      return { rules: paginate(rules, limit ?? DEFAULT_LIMIT, page ?? 1), incidents: paginate(incidents, limit ?? DEFAULT_LIMIT, page ?? 1) };
    }),
  );

  server.tool('watchup_list_alert_channels', 'List configured alert channels for a project.', { ...projectArg }, async ({ project_id }) =>
    run('watchup_list_alert_channels', async () => {
      const id = projectId(project_id);
      const types = ['slack', 'whatsapp', 'telegram', 'discord', 'webhook', 'email'];
      const channels = await Promise.all(
        types.map(async (type) => {
          try {
            return { type, ok: true, data: await get(`/api/v1/projects/${id}/alert-channels/${type}`) };
          } catch (error) {
            return { type, ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      return { channels };
    }),
  );

  server.tool(
    'watchup_list_community_posts',
    'Search community discussions, feature requests, and bug reports.',
    {
      type: z.enum(['discussion', 'feature_request', 'bug_report']).optional(),
      status: z.string().max(32).optional(),
      q: z.string().max(200).optional(),
      ...pageArgs,
    },
    async ({ type, status, q, limit, page }) =>
      run('watchup_list_community_posts', async () =>
        paginate(await get(`/api/v1/community/posts${query({ type, status, q, limit: limit ?? DEFAULT_LIMIT, page })}`), limit ?? DEFAULT_LIMIT, page ?? 1),
      ),
  );

  server.tool('watchup_list_roadmap', 'List community feature requests grouped by roadmap state.', {}, async () =>
    run('watchup_list_roadmap', () => get('/api/v1/community/roadmap')),
  );

  server.tool('watchup_list_shipped', 'List shipped community requests and changelog-style posts.', {}, async () =>
    run('watchup_list_shipped', () => get('/api/v1/community/shipped')),
  );

  server.tool(
    'watchup_create_community_post',
    'Create a community discussion, feature request, or bug report. Requires WATCHUP_TOKEN and WATCHUP_READ_ONLY=false.',
    {
      type: z.enum(['discussion', 'feature_request', 'bug_report']),
      title: z.string().min(3).max(200),
      body: z.string().min(10).max(20_000),
      tags: z.array(z.string().max(40)).max(10).optional(),
      project_id: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    },
    async ({ type, title, body, tags, project_id, metadata }) =>
      run('watchup_create_community_post', () => {
        assertWritable();
        return post('/api/v1/community/posts', {
          type,
          title,
          body,
          tags: tags ?? [],
          project_id: project_id || undefined,
          metadata: normalize(metadata ?? {}),
        });
      }),
  );

  server.tool(
    'watchup_create_bug_report',
    'Create a community bug report with optional linked WatchUp evidence. Requires WATCHUP_TOKEN and WATCHUP_READ_ONLY=false.',
    {
      title: z.string().min(3).max(200),
      body: z.string().min(10).max(20_000),
      severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
      affected_feature: z.string().max(200).optional(),
      project_id: z.string().optional(),
      evidence_type: z.enum(['error', 'log', 'trace', 'alert', 'manual']).optional(),
      evidence_id: z.string().max(100).optional(),
      tags: z.array(z.string().max(40)).max(10).optional(),
    },
    async ({ title, body, severity, affected_feature, project_id, evidence_type, evidence_id, tags }) =>
      run('watchup_create_bug_report', () => {
        assertWritable();
        return post('/api/v1/community/posts', {
          type: 'bug_report',
          title,
          body,
          tags: tags ?? [],
          project_id: project_id || env.defaultProjectId || undefined,
          metadata: {
            severity: severity ?? 'medium',
            affected_feature: affected_feature ?? null,
            evidence: evidence_type || evidence_id ? { type: evidence_type ?? 'manual', id: evidence_id ?? null } : null,
          },
        });
      }),
  );

  server.tool(
    'watchup_create_feature_flag',
    'Create a feature flag for a project. Requires WATCHUP_TOKEN and WATCHUP_READ_ONLY=false.',
    {
      project_id: z.string().optional(),
      key: z.string().min(2).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/i),
      name: z.string().min(2).max(200),
      description: z.string().max(2_000).optional(),
      enabled: z.boolean().optional(),
      rollout_percentage: z.number().min(0).max(100).optional(),
    },
    async ({ project_id, key, name, description, enabled, rollout_percentage }) =>
      run('watchup_create_feature_flag', () => {
        assertWritable();
        return post(`/api/v1/projects/${projectId(project_id)}/flags`, {
          key,
          name,
          description: description ?? '',
          enabled: enabled ?? false,
          rollout_percentage: rollout_percentage ?? 0,
        });
      }),
  );

  return server;
}
