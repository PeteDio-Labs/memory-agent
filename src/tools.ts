/**
 * Deterministic step plans for memory-agent.
 *
 * ingest mode:
 *   1. scan-sessions     — resolve session file(s) to ingest
 *   2. extract-decisions — Ollama (petedio-planner) → JSON array of memories per file
 *   3. store             — insert into SurrealDB
 *
 * query mode:
 *   1. query-db   — fetch memories matching the query
 *   2. summarize  — Ollama synthesizes a coherent answer from retrieved memories
 */

import path from 'node:path';
import type { MemoryAgentInput } from './schema.js';
import {
  ensureSchema,
  insertMemories,
  listSessionFiles,
  ollamaChat,
  queryMemories,
  readSession,
  resolveSessionPath,
  surrealHealthy,
  type MemoryRecord,
  type QueriedMemory,
} from './clients.js';

export type MemoryAction =
  | 'scan-sessions'
  | 'extract-decisions'
  | 'store'
  | 'query-db'
  | 'summarize';

export interface MemoryStep {
  title: string;
  action: MemoryAction;
}

export interface MemoryStepLog {
  step: MemoryStep;
  status: 'complete' | 'failed' | 'skipped';
  output: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface MemoryState {
  files: string[];
  extracted: MemoryRecord[];
  inserted: number;
  retrieved: QueriedMemory[];
  answer: string;
}

export function createInitialState(): MemoryState {
  return { files: [], extracted: [], inserted: 0, retrieved: [], answer: '' };
}

// ─── Plan builder ─────────────────────────────────────────────────

export function buildPlan(input: MemoryAgentInput): MemoryStep[] {
  if (input.mode === 'ingest') {
    return [
      { title: 'Scan session files', action: 'scan-sessions' },
      { title: 'Extract decisions (petedio-planner)', action: 'extract-decisions' },
      { title: 'Store memories in SurrealDB', action: 'store' },
    ];
  }
  return [
    { title: 'Query memories from SurrealDB', action: 'query-db' },
    { title: 'Summarize retrieved memories (petedio-planner)', action: 'summarize' },
  ];
}

// ─── Step executor ────────────────────────────────────────────────

export function createExecuteStep(
  input: MemoryAgentInput,
  state: MemoryState,
): (step: MemoryStep) => Promise<string> {
  return async (step) => {
    switch (step.action) {
      case 'scan-sessions': {
        if (input.sessionFile) {
          const resolved = await resolveSessionPath(input.sessionFile);
          state.files = [resolved];
        } else {
          state.files = await listSessionFiles();
        }
        if (state.files.length === 0) return 'No session files to ingest.';
        return state.files.map((f) => `- ${path.basename(f)}`).join('\n');
      }

      case 'extract-decisions': {
        if (state.files.length === 0) {
          return 'Skipped: no files queued.';
        }
        const collected: MemoryRecord[] = [];
        for (const file of state.files) {
          const content = await readSession(file);
          const truncated = content.length > 24_000 ? content.slice(0, 24_000) + '\n…[truncated]' : content;
          const json = await extractFromSession(path.basename(file), truncated);
          collected.push(...json);
        }
        state.extracted = collected;
        return `Extracted ${collected.length} memory record(s) from ${state.files.length} file(s).`;
      }

      case 'store': {
        if (state.extracted.length === 0) {
          state.inserted = 0;
          return 'Nothing to store.';
        }
        if (!(await surrealHealthy())) {
          throw new Error('SurrealDB unreachable — cannot store memories');
        }
        await ensureSchema();
        state.inserted = await insertMemories(state.extracted);
        return `Inserted ${state.inserted} memory record(s) into SurrealDB.`;
      }

      case 'query-db': {
        if (!input.query) throw new Error('query mode requires query');
        if (!(await surrealHealthy())) {
          throw new Error('SurrealDB unreachable');
        }
        await ensureSchema();
        state.retrieved = await queryMemories(input.query, input.limit);
        if (state.retrieved.length === 0) return 'No memories matched.';
        return state.retrieved
          .map(
            (m, i) =>
              `${i + 1}. [${m.source}] (${m.createdAt})\n   ${truncate(m.content, 200)}`,
          )
          .join('\n');
      }

      case 'summarize': {
        if (!input.query) throw new Error('query mode requires query');
        if (state.retrieved.length === 0) {
          state.answer = `No memories matched "${input.query}".`;
          return state.answer;
        }
        const memoryBlock = state.retrieved
          .map((m, i) => `[M${i + 1}] (${m.source}, ${m.createdAt})\n${m.content}`)
          .join('\n\n');
        const system = [
          'You are PeteDio memory-agent backed by petedio-planner.',
          'Answer the user question using only the retrieved memories.',
          'Cite sources as [M1], [M2]. If memories conflict, say so. If insufficient, say so.',
          'Output: 3-6 sentence answer, then a "Sources" section.',
        ].join(' ');
        const user = [
          `Question: ${input.query}`,
          '',
          'Retrieved memories:',
          memoryBlock,
        ].join('\n');
        state.answer = await ollamaChat([
          { role: 'system', content: system },
          { role: 'user', content: user },
        ]);
        return state.answer;
      }

      default:
        throw new Error(`Unknown memory action: ${(step as MemoryStep).action}`);
    }
  };
}

// ─── Extract helper ───────────────────────────────────────────────

async function extractFromSession(source: string, content: string): Promise<MemoryRecord[]> {
  const system = [
    'Extract durable, factual memory records from the session document.',
    'Each record should capture a decision, architectural choice, or non-obvious gotcha — not narration.',
    'Return ONLY a JSON array. Each item: {"content": string, "tags": string[]}.',
    'Skip TODOs, in-progress notes, or work logs. 0 items is a valid answer.',
  ].join(' ');
  const user = [
    `Session: ${source}`,
    '',
    'Document:',
    content,
    '',
    'Return JSON array now (no commentary, no markdown fences):',
  ].join('\n');
  const raw = await ollamaChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  const parsed = parseJsonArray(raw);
  const now = new Date().toISOString();
  return parsed
    .filter((p) => typeof p?.content === 'string' && p.content.trim().length > 0)
    .map((p) => ({
      source,
      content: String(p.content).trim(),
      tags: Array.isArray(p.tags) ? p.tags.map((t: unknown) => String(t)) : [],
      createdAt: now,
    }));
}

function parseJsonArray(raw: string): Array<{ content?: unknown; tags?: unknown }> {
  // Try whole; if fails, find first [ ... ] block.
  const trimmed = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '');
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // give up
    }
  }
  return [];
}

// ─── Report formatter ─────────────────────────────────────────────

export function formatReport(
  input: MemoryAgentInput,
  state: MemoryState,
  logs: MemoryStepLog[],
): string {
  const lines: string[] = [`# Memory Agent — ${input.mode}`, ''];
  if (input.mode === 'ingest') {
    lines.push(`Files scanned: ${state.files.length}`);
    lines.push(`Records extracted: ${state.extracted.length}`);
    lines.push(`Records inserted: ${state.inserted}`);
  } else {
    lines.push(`Query: ${input.query}`);
    lines.push(`Memories retrieved: ${state.retrieved.length}`);
    if (state.answer) lines.push('', '## Answer', '', state.answer);
  }
  lines.push('', '## Steps', '');
  for (const [i, log] of logs.entries()) {
    lines.push(`${i + 1}. **${log.step.title}** [${log.status}, ${log.durationMs}ms]`);
    if (log.output && log.step.action !== 'summarize') {
      lines.push('', '```', log.output, '```', '');
    }
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}
