import { maskArgsDeep } from "@forge/governance";
import { repos } from "@forge/store";

/**
 * P1 (architect ruling): run events are replayable (SSE), so they are stored masked with the run-output mask
 * (maskArgsDeep) and run_events holds no clear-text credential. message.delta is neither written nor sent any more:
 * the worker emits only the masked message.completed (full text) and the run.* / tool / approval events.
 */
export async function emit(runId: string, type: string, data: unknown): Promise<void> {
  if (type === "message.delta") return;
  await repos.addEvent(runId, type, maskArgsDeep(data));
}
