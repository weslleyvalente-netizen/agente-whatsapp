import { defineConfig } from "vitest/config";

// Os testes de SQL (src/sql) sobem um Postgres em WASM (PGlite) por teste; com vários arquivos em paralelo
// o primeiro boot passa dos 10s padrão. Os demais testes não são afetados.
export default defineConfig({
  test: { hookTimeout: 60_000, testTimeout: 60_000 },
});
