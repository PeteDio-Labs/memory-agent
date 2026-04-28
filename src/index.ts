/**
 * memory-agent — cross-session memory via dedicated SurrealDB instance.
 *
 * ingest mode: scan knowledge/sessions/, extract decisions with petedio-planner,
 *              persist to SurrealDB (rocksdb backend, port 8001).
 * query mode:  retrieve matching memories and summarize.
 */

import express from 'express';
import pino from 'pino';
import { z } from 'zod';
import { MemoryAgentInputSchema } from './schema.js';
import {
  buildPlan,
  createExecuteStep,
  createInitialState,
  formatReport,
  type MemoryStep,
  type MemoryStepLog,
} from './tools.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const PORT = parseInt(process.env.PORT ?? '3013', 10);
const MC_BACKEND_URL = process.env.MC_BACKEND_URL ?? 'http://localhost:3000';
const SHARED_AGENTS_MODULE_PATH = process.env.SHARED_AGENTS_MODULE_PATH ?? '@petedio/shared/agents';

interface SharedAgentReporter {
  running(message: string): Promise<void>;
  complete(result: {
    taskId: string;
    agentName: string;
    status: 'complete';
    summary: string;
    artifacts: Array<{ type: string; label: string; content: string }>;
    durationMs: number;
    completedAt: string;
  }): Promise<void>;
  fail(message: string): Promise<void>;
}

interface SharedAgentsModule {
  AgentReporter: new (opts: { mcUrl: string; taskId: string; agentName: string }) => SharedAgentReporter;
  TaskPayloadSchema: z.ZodType<{
    taskId: string;
    agentName: string;
    trigger: string;
    input: Record<string, unknown>;
    issuedAt: string;
  }>;
  runDeterministicPlan: (opts: {
    steps: MemoryStep[];
    executeStep: (step: MemoryStep) => Promise<string>;
    onStepStart?: (step: MemoryStep, index: number) => void | Promise<void>;
    stopOnError?: boolean;
  }) => Promise<{
    status: 'complete' | 'failed';
    logs: MemoryStepLog[];
    completedSteps: number;
    skippedSteps: number;
    failedStep?: MemoryStepLog;
  }>;
}

async function loadSharedAgents(): Promise<SharedAgentsModule> {
  return import(SHARED_AGENTS_MODULE_PATH) as Promise<SharedAgentsModule>;
}

async function runMemory(payload: { taskId: string; input: Record<string, unknown> }): Promise<void> {
  const startMs = Date.now();
  const input = MemoryAgentInputSchema.parse(payload.input);
  const shared = await loadSharedAgents();
  const { AgentReporter, runDeterministicPlan } = shared;

  const reporter = new AgentReporter({
    mcUrl: MC_BACKEND_URL,
    taskId: payload.taskId,
    agentName: 'memory-agent',
  });

  await reporter.running(`Starting memory-agent (${input.mode})...`);
  log.info({ taskId: payload.taskId, input }, 'memory-agent starting');

  const steps = buildPlan(input);
  const state = createInitialState();
  const executeStep = createExecuteStep(input, state);

  try {
    const result = await runDeterministicPlan({
      steps,
      executeStep,
      onStepStart: async (step, index) => {
        await reporter.running(`Step ${index + 1}/${steps.length}: ${step.title}`);
      },
    });

    const durationMs = Date.now() - startMs;
    const report = formatReport(input, state, result.logs);
    const summary = result.failedStep
      ? `Failed at: ${result.failedStep.step.title}`
      : input.mode === 'ingest'
        ? `Ingested ${state.inserted} memory record(s) from ${state.files.length} file(s)`
        : `Retrieved ${state.retrieved.length} memory record(s)`;

    log.info(
      { taskId: payload.taskId, durationMs, mode: input.mode, status: result.status },
      'memory-agent complete',
    );

    if (result.status === 'failed') {
      await reporter.fail(`${summary}\n\n${report}`);
      return;
    }

    await reporter.complete({
      taskId: payload.taskId,
      agentName: 'memory-agent',
      status: 'complete',
      summary,
      artifacts: [
        { type: 'memory-report', label: `Memory ${input.mode}`, content: report },
      ],
      durationMs,
      completedAt: new Date().toISOString(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ taskId: payload.taskId, err: msg }, 'memory-agent failed');
    await reporter.fail(msg);
  }
}

// ─── HTTP Server ──────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '1mb' }));

const shared = await loadSharedAgents();
const { TaskPayloadSchema } = shared;

app.post('/run', async (req, res) => {
  const parsed = TaskPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid task payload', details: parsed.error.flatten() });
    return;
  }
  res.json({ accepted: true, taskId: parsed.data.taskId });
  runMemory(parsed.data).catch((err) => {
    log.error({ err: err instanceof Error ? err.message : err }, 'Unhandled memory-agent error');
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agent: 'memory-agent',
    sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH,
    ollamaModel: process.env.OLLAMA_MODEL ?? 'petedio-planner',
    surrealUrl: process.env.SURREAL_URL ?? 'http://localhost:8001',
  });
});

app.listen(PORT, () => {
  log.info({ port: PORT, sharedAgentsModulePath: SHARED_AGENTS_MODULE_PATH }, 'memory-agent listening');
});
