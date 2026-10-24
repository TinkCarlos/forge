import { maskArgsDeep } from "@forge/governance";
import { repos } from "@forge/store";

/**
 * P1: run events are replayable (SSE), so they are stored masked with the run-output mask (maskArgsDeep) and
 * run_events holds no clear-text credential. message.delta chunks come already masked over the accumulated message
 * (createDeltaBuffer -> createStreamMasker, flagged `masked: true`) and are stored as they are.
 */
export async function emit(runId: string, type: string, data: unknown): Promise<void> {
  const preMasked = type === "message.delta" && data !== null && typeof data === "object" && (data as Record<string, unknown>).masked === true;
  await repos.addEvent(runId, type, preMasked ? data : maskArgsDeep(data));
}
