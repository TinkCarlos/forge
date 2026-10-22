import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const api = process.env.FORGE_API_URL ?? "http://127.0.0.1:3100";

// 新控制台与旧版 public/ 并存：构建产物放 dist/，挂在 /next/ 下，切换前不影响旧页面。
export default defineConfig({
  base: "/next/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    port: 5175,
    proxy: Object.fromEntries(["/admin", "/auth", "/open", "/integration", "/healthz", "/readyz"].map((path) => [path, { target: api, changeOrigin: false }])),
  },
  build: { outDir: "dist", emptyOutDir: true },
});
