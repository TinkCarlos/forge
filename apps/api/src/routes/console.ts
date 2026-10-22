import fs from "node:fs";
import path from "node:path";
import { type FastifyInstance } from "fastify";

// 新控制台（apps/console，Vite 构建）挂在 /next/ 下，与旧版 public/ 并存。
// 固定只注册 /next 与 /next/* 两条路由，不随 dist 是否存在而变化，路由快照保持确定。
const consoleDist = () => path.resolve(process.cwd(), "apps/console/dist");

export default async function consoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", async (_request, reply) => {
    const file = path.resolve(process.cwd(), "apps/console/public/index.html");
    return reply.type("text/html").send(fs.readFileSync(file, "utf8"));
  });

  app.get("/next", async (_request, reply) => reply.redirect("/next/"));

  app.get("/next/*", async (request, reply) => {
    const root = consoleDist();
    if (!fs.existsSync(path.join(root, "index.html"))) {
      return reply.code(503).type("text/plain; charset=utf-8").send("新控制台尚未构建，请先运行 pnpm build:console");
    }
    const rel = path.normalize((request.params as { "*"?: string })["*"] ?? "");
    const isAsset =
      rel !== "." && rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) &&
      fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile();
    if (isAsset) {
      const hashed = rel.startsWith(`assets${path.sep}`);
      return reply.sendFile(rel, root, hashed ? { maxAge: "365d", immutable: true } : { cacheControl: false });
    }
    // SPA 回退：前端路由由 index.html 接管，且不缓存，保证发布后立刻拿到新入口。
    reply.header("cache-control", "no-cache");
    return reply.sendFile("index.html", root, { cacheControl: false });
  });
}
