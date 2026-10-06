// Loader for spec/fixtures/vectors.json (generator syntax: spec/fixtures/README.md).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_DIR = join(here, '..', '..', 'spec');

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export const vectors: Json = JSON.parse(readFileSync(join(SPEC_DIR, 'fixtures', 'vectors.json'), 'utf8'));
export const schema: Json = JSON.parse(readFileSync(join(SPEC_DIR, 'envelope.schema.json'), 'utf8'));

function expand(value: Json, i: number): Json {
  if (typeof value === 'string') return value.replace(/\{i\}/g, String(i));
  if (Array.isArray(value)) return value.map((v) => expand(v, i));
  if (value && typeof value === 'object') {
    if ('$repeat' in value) return String(value.$repeat).repeat(value.times);
    if ('$object' in value) {
      const spec = value.$object;
      const out: Record<string, Json> = {};
      for (let j = 0; j < spec.count; j++) {
        out[String(spec.key).replace(/\{j\}/g, String(j))] = expand(spec.value, i);
      }
      return out;
    }
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expand(v, i);
    return out;
  }
  return value;
}

export type Kind = 'errors' | 'traces' | 'events';

/** Materialize a chunking vector's input arrays. */
export function vectorInput(vector: Json): Record<Kind, Json[]> {
  const out: Record<Kind, Json[]> = { errors: [], traces: [], events: [] };
  for (const kind of ['errors', 'traces', 'events'] as const) {
    if (vector.input?.[kind]) out[kind].push(...vector.input[kind]);
    const gen = vector.generate?.[kind];
    if (gen) for (let i = 0; i < gen.count; i++) out[kind].push(expand(gen.template, i));
  }
  return out;
}

export function label(kind: Kind, item: Json): string {
  const field = kind === 'errors' ? 'message' : kind === 'traces' ? 'span' : 'name';
  return `${kind}:${item[field]}`;
}

/** Minimal JSON-schema check for the envelope (required keys + item required keys). */
export function validateEnvelope(body: Json): string[] {
  const problems: string[] = [];
  for (const key of schema.required) if (!(key in body)) problems.push(`missing ${key}`);
  const defs: Record<Kind, string> = { errors: 'error', traces: 'trace', events: 'event' };
  for (const kind of ['errors', 'traces', 'events'] as const) {
    const required: string[] = schema.$defs[defs[kind]].required;
    for (const item of body[kind] ?? []) {
      for (const key of required) if (!(key in item)) problems.push(`${kind} item missing ${key}`);
    }
  }
  if (!/^wu_[A-Za-z0-9-]+_\d+$/.test(body.idempotency_key ?? '')) problems.push('bad idempotency_key');
  if (!body.sdk?.name || !body.sdk?.version) problems.push('missing sdk name/version');
  return problems;
}
