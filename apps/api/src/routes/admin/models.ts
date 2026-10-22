import { type FastifyInstance } from "fastify";
import { config, encryptSecret, errors, ForgeError } from "@forge/core";
import { callModel } from "@forge/models";
import { repos } from "@forge/store";
import {
  bodyOf,
  param,
  stringBody,
  jsonBody,
  admin,
  writeAudit,
  requireBodyString,
} from "../../plugins/http-helpers.js";

export default async function adminModelRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/providers", async (request) => {
    await admin(request, "model.view");
    const providers = await repos.listProviders();
    const items = await Promise.all(
      providers.map(async (provider) => ({
        id: provider.id,
        key: provider.key,
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.base_url,
        status: provider.status,
        models: (await repos.listModels(provider.id)).map((model) => ({
          id: model.id,
          key: model.key,
          displayName: model.display_name,
          capabilities: model.capabilities_json,
          contextWindow: model.context_window,
          maxOutputTokens: model.max_output_tokens,
        })),
      })),
    );
    return { items };
  });

  app.post("/admin/api/providers", async (request) => {
    const session = await admin(request, "model.manage");
    const body = bodyOf(request);
    const key = requireBodyString(body, "key");
    if (await repos.getProviderByKey(key)) throw errors.conflict("Provider key 已存在");
    const apiKey = stringBody(body, "apiKey");
    const providerId = await repos.createProvider({
      key,
      name: stringBody(body, "name", key),
      protocol: stringBody(body, "protocol", "openai-compatible"),
      baseUrl: requireBodyString(body, "baseUrl"),
      apiKeyEncrypted: apiKey ? encryptSecret(apiKey, config.FORGE_MASTER_KEY) : null,
      headers: jsonBody(body, "headers", {}),
      timeoutMs: Number(body.timeoutMs ?? 120000),
      createdBy: session.principal.id,
    });
    await writeAudit(session, "provider.create", "llm_provider", providerId, { key });
    return { id: providerId };
  });

  app.post("/admin/api/providers/:id/models", async (request) => {
    const session = await admin(request, "model.manage");
    const provider = await repos.getProviderById(param(request, "id"));
    if (!provider) throw errors.notFound("Provider 不存在");
    const body = bodyOf(request);
    const modelId = await repos.createModel({
      providerId: provider.id,
      key: requireBodyString(body, "key"),
      displayName: stringBody(body, "displayName", stringBody(body, "key")),
      capabilities: jsonBody(body, "capabilities", ["text", "tools"]),
      contextWindow: Number(body.contextWindow ?? 32768),
      maxOutputTokens: Number(body.maxOutputTokens ?? 4096),
      inputPrice: Number(body.inputPrice ?? 0),
      outputPrice: Number(body.outputPrice ?? 0),
    });
    await writeAudit(session, "model.create", "llm_model", modelId, { providerId: provider.id });
    return { id: modelId };
  });

  app.patch("/admin/api/providers/:id", async (request) => {
    const session = await admin(request, "model.manage");
    const provider = await repos.getProviderById(param(request, "id"));
    if (!provider) throw errors.notFound("Provider 不存在");
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.name !== undefined) fields.name = stringBody(body, "name");
    if (body.protocol !== undefined) fields.protocol = stringBody(body, "protocol");
    if (body.baseUrl !== undefined) fields.base_url = stringBody(body, "baseUrl");
    if (body.apiKey) fields.api_key_encrypted = encryptSecret(stringBody(body, "apiKey"), config.FORGE_MASTER_KEY);
    if (body.headers !== undefined) fields.headers_json = jsonBody(body, "headers", {});
    if (body.timeoutMs !== undefined) fields.timeout_ms = Number(body.timeoutMs);
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    await repos.updateProvider(provider.id, fields);
    await writeAudit(session, "provider.update", "llm_provider", provider.id, { name: fields.name, status: fields.status });
    return { ok: true };
  });

  app.patch("/admin/api/models/:id", async (request) => {
    const session = await admin(request, "model.manage");
    const model = await repos.getModelById(param(request, "id"));
    if (!model) throw errors.notFound("模型不存在");
    const body = bodyOf(request);
    const fields: Record<string, unknown> = {};
    if (body.displayName !== undefined) fields.display_name = stringBody(body, "displayName");
    if (body.capabilities !== undefined) fields.capabilities_json = jsonBody(body, "capabilities", []);
    if (body.contextWindow !== undefined) fields.context_window = Number(body.contextWindow);
    if (body.maxOutputTokens !== undefined) fields.max_output_tokens = Number(body.maxOutputTokens);
    if (body.inputPrice !== undefined) fields.input_price_per_mtok = Number(body.inputPrice);
    if (body.outputPrice !== undefined) fields.output_price_per_mtok = Number(body.outputPrice);
    if (body.status !== undefined) fields.status = stringBody(body, "status");
    await repos.updateModel(model.id, fields);
    await writeAudit(session, "model.update", "llm_model", model.id, { displayName: fields.display_name });
    return { ok: true };
  });

  app.post("/admin/api/providers/:id/test", async (request) => {
    await admin(request, "model.manage");
    const provider = await repos.getProviderById(param(request, "id"));
    if (!provider) throw errors.notFound("Provider 不存在");
    const models = await repos.listModels(provider.id);
    const model = models[0];
    if (!model) throw errors.invalid("Provider 还没有模型");
    try {
      const result = await callModel({
        providerKey: provider.key,
        modelKey: model.key,
        messages: [{ role: "user", content: "请回复 pong" }],
        tools: [],
      });
      return { ok: true, content: result.content, usage: result.usage };
    } catch (error) {
      return { ok: false, error: error instanceof ForgeError ? error.message : String(error) };
    }
  });
}
