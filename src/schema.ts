import { z } from 'zod';
import { TaskPayloadSchema } from '@petedio/shared/agents';

export const MemoryAgentInputSchema = z
  .object({
    mode: z.enum(['ingest', 'query']).describe('ingest: scan sessions and store decisions; query: retrieve and summarize'),
    query: z.string().optional().describe('Required for mode=query'),
    sessionFile: z
      .string()
      .optional()
      .describe('Optional path (relative to KNOWLEDGE_ROOT or absolute) for ingest. Omit to scan all session files.'),
    limit: z.number().int().min(1).max(100).default(20)
      .describe('Max memories to retrieve in query mode'),
  })
  .superRefine((input, ctx) => {
    if (input.mode === 'query' && !input.query) {
      ctx.addIssue({ code: 'custom', message: 'mode=query requires query' });
    }
  });

export type MemoryAgentInput = z.infer<typeof MemoryAgentInputSchema>;

export const MemoryTaskPayloadSchema = TaskPayloadSchema.extend({
  input: MemoryAgentInputSchema,
});
