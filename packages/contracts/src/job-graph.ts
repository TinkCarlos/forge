import type { JobCondition, JobMapping } from "./job-definitions.js";
interface GraphNode { key: string; dependsOn: string[]; maxIterations?: number; inputMapping: JobMapping; condition: JobCondition | null }
export interface JobGraphIssue { path: (string | number)[]; message: string }

export function jobGraphIssues(nodes: GraphNode[], outcomeNodeKey?: string): JobGraphIssue[] {
  const issues: JobGraphIssue[] = [], byKey = new Map(nodes.map(node => [node.key, node]));
  function ancestors(key: string): Set<string> {
    const result = new Set<string>(), stack = [...(byKey.get(key)?.dependsOn ?? [])];
    while (stack.length) {
      const parent = stack.pop()!;
      if (result.has(parent)) continue;
      result.add(parent);
      stack.push(...(byKey.get(parent)?.dependsOn ?? []));
    }
    return result;
  }
  function refs(mapping: JobMapping): string[] {
    if ("ref" in mapping) return [mapping.ref];
    if ("literal" in mapping) return [];
    return ("array" in mapping ? mapping.array : Object.values(mapping.object)).flatMap(refs);
  }
  function conditionRefs(condition: JobCondition | null): string[] {
    if (condition === null || typeof condition === "boolean") return [];
    if (condition.op === "exists") return [condition.ref];
    if (condition.op === "and" || condition.op === "or") return condition.args.flatMap(conditionRefs);
    if (condition.op === "not") return conditionRefs(condition.arg);
    return "left" in condition ? [...refs(condition.left), ...refs(condition.right)] : [];
  }
  nodes.forEach((node, index) => {
    const available = ancestors(node.key), cyclic = available.has(node.key);
    if (cyclic && node.maxIterations === undefined) issues.push({ path: ["nodes", index, "maxIterations"], message: "回环节点须明确声明循环上限" });
    if (cyclic && node.key === outcomeNodeKey) issues.push({ path: ["outcomeNodeKey"], message: "输出节点不能位于回环中" });
    for (const pointer of [...refs(node.inputMapping), ...conditionRefs(node.condition)]) {
      const parts = pointer.slice(1).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      if (parts[0] === "steps" && parts[1] && !available.has(parts[1])) issues.push({ path: ["nodes", index], message: "步骤引用须声明可用依赖" });
    }
  });
  return issues;
}
