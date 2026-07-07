// @ts-check
import { defineConfig, envField } from "astro/config";

import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import cloudflare from "@astrojs/cloudflare";

// https://astro.build/config
export default defineConfig({
  output: "server",
  integrations: [react(), sitemap()],
  vite: {
    plugins: [tailwindcss()],
  },
  adapter: cloudflare(),
  env: {
    schema: {
      SUPABASE_URL: envField.string({ context: "server", access: "secret", optional: true }),
      SUPABASE_KEY: envField.string({ context: "server", access: "secret", optional: true }),
      // Garmin integration (S-01): URL + shared secret for the off-edge sidecar,
      // and the server key used to encrypt the stored Garmin password.
      GARMIN_SIDECAR_URL: envField.string({ context: "server", access: "secret", optional: true }),
      GARMIN_SIDECAR_SECRET: envField.string({ context: "server", access: "secret", optional: true }),
      GARMIN_PASSWORD_ENC_KEY: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
