/**
 * Clients for memory-agent.
 * Talks to a dedicated SurrealDB instance (rocksdb backend) and Ollama.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SURREAL_URL = process.env.SURREAL_URL || 'http://localhost:8001';
const SURREAL_NS = process.env.SURREAL_NS || 'petedio';
const SURREAL_DB = process.env.SURREAL_DB || 'homelab';
const SURREAL_USER = process.env.SURREAL_USER || 'root';
const SURREAL_PASS = process.env.SURREAL_PASS || 'root';
const SURREAL_TIMEOUT_MS = 15_000;

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.50.59:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'petedio-planner';
const OLLAMA_TIMEOUT_MS = 120_000;

export const KNOWLEDGE_ROOT =
  process.env.KNOWLEDGE_ROOT || '/home/pedro/PeteDio-Labs/knowledge/sessions';

// ─── SurrealDB ────────────────────────────────────────────────────

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${SURREAL_USER}:${SURREAL_PASS}`).toString('base64');
}

export async function surrealSql<T = unknown>(sql: string, vars: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`${SURREAL_URL}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: authHeader(),
      NS: SURREAL_NS,
      DB: SURREAL_DB,
    },
    // SurrealDB HTTP /sql expects: body=raw SQL string when content-type=text/plain,
    // or {sql, vars} when content-type=application/json. Some versions accept both.
    body: JSON.stringify({ sql, vars }),
    signal: AbortSignal.timeout(SURREAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SurrealDB ${res.status}${body ? ` :: ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export async function surrealRawSql<T = unknown>(sql: string): Promise<T> {
  // Fallback for SurrealDB versions that prefer raw text bodies
  const res = await fetch(`${SURREAL_URL}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      Accept: 'application/json',
      Authorization: authHeader(),
      NS: SURREAL_NS,
      DB: SURREAL_DB,
    },
    body: sql,
    signal: AbortSignal.timeout(SURREAL_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SurrealDB ${res.status}${body ? ` :: ${body}` : ''}`);
  }
  return res.json() as Promise<T>;
}

export interface MemoryRecord {
  source: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export async function ensureSchema(): Promise<void> {
  const ddl = [
    'DEFINE TABLE memories SCHEMAFULL;',
    'DEFINE FIELD source ON memories TYPE string;',
    'DEFINE FIELD content ON memories TYPE string;',
    'DEFINE FIELD tags ON memories TYPE array DEFAULT [];',
    'DEFINE FIELD createdAt ON memories TYPE datetime DEFAULT time::now();',
    'DEFINE INDEX memories_source ON memories COLUMNS source;',
  ].join('\n');
  await surrealRawSql(ddl);
}

export async function insertMemories(records: MemoryRecord[]): Promise<number> {
  if (records.length === 0) return 0;
  let inserted = 0;
  for (const r of records) {
    const sql = `CREATE memories SET source = $source, content = $content, tags = $tags, createdAt = $createdAt;`;
    await surrealSql(sql, r as unknown as Record<string, unknown>);
    inserted += 1;
  }
  return inserted;
}

export interface QueriedMemory {
  id: string;
  source: string;
  content: string;
  tags: string[];
  createdAt: string;
}

export async function queryMemories(query: string, limit: number): Promise<QueriedMemory[]> {
  const sql = `SELECT id, source, content, tags, createdAt FROM memories WHERE string::lowercase(content) CONTAINS string::lowercase($q) ORDER BY createdAt DESC LIMIT ${Math.max(1, Math.min(limit, 100))};`;
  const result = (await surrealSql<Array<{ status: string; result: QueriedMemory[] }>>(sql, { q: query }));
  if (!Array.isArray(result) || result.length === 0) return [];
  const first = result[0];
  if (first?.status !== 'OK') return [];
  return Array.isArray(first.result) ? first.result : [];
}

export async function surrealHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${SURREAL_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Filesystem ───────────────────────────────────────────────────

export async function listSessionFiles(): Promise<string[]> {
  const entries = await readdir(KNOWLEDGE_ROOT, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => path.join(KNOWLEDGE_ROOT, e.name))
    .sort();
}

export async function resolveSessionPath(input: string): Promise<string> {
  const candidates = [input, path.join(KNOWLEDGE_ROOT, input)];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      if (s.isFile()) return p;
    } catch {
      // try next
    }
  }
  throw new Error(`Session file not found: ${input}`);
}

export async function readSession(filePath: string): Promise<string> {
  return readFile(filePath, 'utf8');
}

// ─── Ollama ───────────────────────────────────────────────────────

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function ollamaChat(messages: OllamaChatMessage[], model = OLLAMA_MODEL): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama → ${res.status}${body ? ` :: ${body}` : ''}`);
  }
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? '';
}
