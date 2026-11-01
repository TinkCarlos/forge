import type { FastifyInstance } from "fastify";
import { revisionTag, validateSecretValue } from "@forge/core";
import { SECRET_DETAIL_SCHEMA, type SecretScope } from "@forge/contracts";
import { secretFilterFor, validateSecretScope, assertSecretWritable } from "@forge/governance";
import { repos } from "@forge/store";
import { errors } from "@forge/core";
import { admin, bodyOf, configurationResult, configurationWrite, enumBody, param, requireBodyString, stringBody } from "../../plugins/http-helpers.js";
import { ROUTE_SCHEMAS, assertValidInput } from "../../plugins/input-schema.js";

export default async function adminSecretRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/api/secrets", { schema: ROUTE_SCHEMAS.secretList, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "secret.manage");
    assertValidInput(request, "querystring");
    const query = request.query as { limit?: string; cursor?: string };
    reply.header("Cache-Control", "no-store");
    return repos.listSecrets(await secretFilterFor(session.principal), { limit: query.limit ? Number(query.limit) : undefined, cursor: query.cursor });
  });
  app.post("/admin/api/secrets", { schema: ROUTE_SCHEMAS.secretCreate, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "secret.manage");
    assertValidInput(request);
    const body = bodyOf(request), value = stringBody(body, "value"), scope = body.scope as SecretScope;
    validateSecretValue(value);
    const orgUnitId = await validateSecretScope(session.principal, scope);
    const result = await repos.createSecret({ key: requireBodyString(body, "key"), name: requireBodyString(body, "name"), description: stringBody(body, "description"), scope, value, orgUnitId, createdBy: session.principal.id }, { actorType: "user", actorId: session.principal.id, action: "secret.create", resourceType: "secret", resourceId: null, details: { scope, name: body.name }, orgUnitId });
    reply.header("ETag", revisionTag(result.revision)).header("Cache-Control", "no-store");
    return result;
  });
  app.get("/admin/api/secrets/:id", { schema: { response: { 200: SECRET_DETAIL_SCHEMA } } }, async (request, reply) => {
    const session = await admin(request, "secret.manage");
    const secret = await repos.getSecretDetail(param(request, "id"), await secretFilterFor(session.principal));
    if (!secret) throw errors.notFound("凭据不存在");
    reply.header("ETag", revisionTag(secret.revision)).header("Cache-Control", "no-store");
    return secret;
  });
  app.patch("/admin/api/secrets/:id", { schema: ROUTE_SCHEMAS.secretPatch, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "secret.manage");
    const secret = await repos.getSecret(param(request, "id"), await secretFilterFor(session.principal));
    if (!secret) throw errors.notFound("凭据不存在");
    await assertSecretWritable(session.principal, secret);
    assertValidInput(request);
    const body = bodyOf(request);
    const fields = { name: body.name === undefined ? undefined : stringBody(body, "name"), description: body.description === undefined ? undefined : stringBody(body, "description"), status: enumBody(body, "status", ["active", "disabled"] as const) };
    const write = configurationWrite(request, session, "secret.update", "secret", secret.id, { name: body.name, status: body.status }, secret.orgUnitId);
    const revision = await repos.updateSecret(secret.id, fields, write);
    return { ...configurationResult(reply, revision), id: secret.id };
  });
  app.post("/admin/api/secrets/:id/rotate", { schema: ROUTE_SCHEMAS.secretRotate, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "secret.manage");
    const secret = await repos.getSecret(param(request, "id"), await secretFilterFor(session.principal));
    if (!secret) throw errors.notFound("凭据不存在");
    await assertSecretWritable(session.principal, secret);
    assertValidInput(request);
    const body = bodyOf(request), value = stringBody(body, "value");
    validateSecretValue(value);
    const write = configurationWrite(request, session, "secret.rotate", "secret", secret.id, undefined, secret.orgUnitId);
    const revision = await repos.rotateSecret(secret.id, value, write);
    return { ...configurationResult(reply, revision), id: secret.id };
  });
  app.delete("/admin/api/secrets/:id", { schema: ROUTE_SCHEMAS.secretDelete, attachValidation: true }, async (request, reply) => {
    const session = await admin(request, "secret.manage");
    const secret = await repos.getSecret(param(request, "id"), await secretFilterFor(session.principal));
    if (!secret) throw errors.notFound("凭据不存在");
    await assertSecretWritable(session.principal, secret);
    assertValidInput(request);
    const write = configurationWrite(request, session, "secret.delete", "secret", secret.id, undefined, secret.orgUnitId);
    const revision = await repos.deleteSecret(secret.id, write);
    return { ...configurationResult(reply, revision), id: secret.id };
  });
}
