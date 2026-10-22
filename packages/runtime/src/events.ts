import { repos } from "@forge/store";

export async function emit(runId: string, type: string, data: unknown): Promise<void> {
  await repos.addEvent(runId, type, data);
}
