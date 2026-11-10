import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Alias "@" igual ao do tsconfig, para testar componentes que importam "@/...".
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
});
