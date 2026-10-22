import type { AgentSpec } from "@forge/core";

export interface ModelCandidate {
  provider: string;
  model: string;
}

export function modelCandidates(spec: AgentSpec): ModelCandidate[] {
  const primary = { provider: spec.model.provider, model: spec.model.model };
  const fallbackProvider = spec.model.fallbackProvider;
  const fallbackModel = spec.model.fallbackModel;
  if (!fallbackProvider || !fallbackModel) return [primary];
  if (fallbackProvider === primary.provider && fallbackModel === primary.model) return [primary];
  return [primary, { provider: fallbackProvider, model: fallbackModel }];
}

export function decideAfterModelError(state: {
  index: number;
  attempt: number;
  maxAttempts: number;
  candidateCount: number;
  retryable: boolean;
}): { kind: "retry"; index: number; attempt: number } | { kind: "fallback"; index: number; attempt: number } | { kind: "fail" } {
  if (!state.retryable) return { kind: "fail" };
  if (state.attempt < state.maxAttempts) return { kind: "retry", index: state.index, attempt: state.attempt + 1 };
  if (state.index + 1 < state.candidateCount) return { kind: "fallback", index: state.index + 1, attempt: 1 };
  return { kind: "fail" };
}

export function createDeltaBuffer(flush: (delta: string) => Promise<void>, size = 24) {
  let pending = "";
  const flushPending = async (force: boolean): Promise<void> => {
    while (pending.length >= size) {
      const chunk = pending.slice(0, size);
      pending = pending.slice(size);
      await flush(chunk);
    }
    if (force && pending.length > 0) {
      const chunk = pending;
      pending = "";
      await flush(chunk);
    }
  };
  return {
    push: async (delta: string): Promise<void> => {
      pending += delta;
      await flushPending(false);
    },
    end: async (): Promise<void> => {
      await flushPending(true);
    },
  };
}
