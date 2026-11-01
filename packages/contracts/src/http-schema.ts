/** Preserve semantic unions while making raw HTTP type/size limits explicit for validators and generators. */
export function boundedHttpSchema<T extends object>(schema: T): T {
    const copy = structuredClone(schema);
    function visit(value: unknown): void {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return;
        const node = value as Record<string, unknown>;
        const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
        if (branches) {
            for (const branch of branches)
                visit(branch);
            if (node.type === undefined) {
                const types = branches.flatMap(branch => { const type = (branch as Record<string, unknown>).type; return typeof type === "string" ? [type] : Array.isArray(type) ? type : []; });
                if (types.length === branches.length)
                    node.type = [...new Set(types)];
            }
        }
        const types = Array.isArray(node.type) ? node.type : [node.type];
        if (types.includes("string") && node.maxLength === undefined)
            node.maxLength = Array.isArray(node.enum) && node.enum.every(item => typeof item === "string") ? Math.max(...node.enum.map(item => Array.from(item as string).length)) : 65536;
        if (types.includes("array") && node.maxItems === undefined)
            node.maxItems = 1000;
        if (node.properties && typeof node.properties === "object")
            for (const item of Object.values(node.properties))
                visit(item);
        visit(node.items);
        visit(node.additionalProperties);
    }
    visit(copy);
    return copy;
}
