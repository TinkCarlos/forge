import { ForgeError } from "@forge/core";
import { messageFanoutRepo, type MessageEvent, type FrozenMessageTarget } from "@forge/store";
import { maskProseSecrets } from "@forge/governance";
import { renderMessageTemplate, wecomTextBody } from "./message-protocol.js";
export function renderEventMessage(event: MessageEvent, target: FrozenMessageTarget): {
    body: string;
    errorCode: string | null;
} {
    if (target.type === "webhook")
        return { body: JSON.stringify({ id: event.id, type: event.type, version: "1", createdAt: event.createdAt, data: event.data }), errorCode: null };
    try {
        const values = Object.fromEntries(Object.entries(event.values).map(([name, value]) => [name, maskProseSecrets(value)]));
        const content = target.template ? renderMessageTemplate(target.template, values) : renderMessageTemplate({ key: "builtin-summary", name: "内置摘要", content: "{{taskName}}：{{status}}\n{{executionId}}{{runId}}\n{{url}}", variables: ["taskName", "status", "executionId", "runId", "url"] }, { ...values, taskName: Array.from(values.taskName ?? "任务").slice(0, 128).join(""), status: values.status ?? event.type, executionId: values.executionId ?? "", runId: values.runId ?? "", url: values.url ?? "" });
        return { body: wecomTextBody(content, { mentionedIds: target.mentionedIds, mentionedMobiles: target.mentionedMobiles }), errorCode: null };
    }
    catch (error) {
        if (!(error instanceof ForgeError))
            throw error;
        return { body: JSON.stringify({ test: false, renderFailed: true, eventId: event.id }), errorCode: "MSG-7204" };
    }
}
export async function fanoutMessages(): Promise<void> { for (const row of await messageFanoutRepo.due())
    await messageFanoutRepo.process(row.id, renderEventMessage); }
