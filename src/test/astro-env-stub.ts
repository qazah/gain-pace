/**
 * Test-only stand-in for the `astro:env/server` virtual module (which only
 * exists inside Astro's build). vitest.config.ts aliases `astro:env/server` to
 * this file so the service + crypto modules import cleanly under Vitest.
 *
 * These are dummy values — every sidecar call is mocked in tests, so the URL /
 * secret are never used against a network. This is NOT a real Garmin secret,
 * which keeps CI's "no Garmin secret present" invariant intact.
 */
export const SUPABASE_URL = "http://localhost:54321";
export const SUPABASE_KEY = "test-anon-key";
export const GARMIN_SIDECAR_URL = "https://sidecar.test";
export const GARMIN_SIDECAR_SECRET = "test-sidecar-secret";
export const GARMIN_PASSWORD_ENC_KEY = "test-password-encryption-key-0123456789";
export const ANTHROPIC_API_KEY = "test-anthropic-key";
