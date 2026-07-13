import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// First test runner in the repo (Vitest — native to the Vite/Astro stack).
// `astro:env/server` is a build-only virtual module; alias it to a test stub so
// the service + crypto modules import under Vitest. Real Garmin/Supabase secrets
// are never present — tests mock the sidecar (stubbed fetch).
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "astro:env/server": fileURLToPath(new URL("./src/test/astro-env-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
