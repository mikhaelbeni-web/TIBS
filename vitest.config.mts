import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Les tests sur émulateur partagent la même base : un fichier à la fois.
  test: { fileParallelism: false },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // « server-only » refuse d'être importé hors de Next : neutralisé pour les tests.
      "server-only": fileURLToPath(new URL("./src/lib/__tests__/empty.ts", import.meta.url)),
    },
  },
});
