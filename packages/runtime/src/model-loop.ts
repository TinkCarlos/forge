import type { AgentSpec } from "@forge/core";
import { createStreamMasker } from "@forge/governance";

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

/**
 * Streamed model text -> message.delta chunks. P1: the text is masked before it is chunked (createStreamMasker: the
 * accumulated message masked with maskArgsDeep, only the stable prefix released), so no clear-text credential reaches
 * run_events or the SSE stream. Chunks never cut a `***` placeholder (a run of `*`) or a surrogate pair.
 */
export function createDeltaBuffer(flush: (delta: string) => Promise<void>, size = 24) {
  let pending = "";
  const masker = createStreamMasker();
  const cutAt = (text: string): number => {
    let cut = size;
    while (cut < text.length && ((text[cut - 1] === "*" && text[cut] === "*") || /[\uD800-\uDBFF]/.test(text[cut - 1]!))) cut += 1;
    return cut;
  };
  const flushPending = async (force: boolean): Promise<void> => {
    while (pending.length >= size) {
      const cut = cutAt(pending);
      const chunk = pending.slice(0, cut);
      pending = pending.slice(cut);
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
      pending += masker.push(delta);
      await flushPending(false);
    },
    end: async (): Promise<void> => {
      pending += masker.end();
      await flushPending(true);
    },
  };
}
