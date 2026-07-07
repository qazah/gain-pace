import {
  SUPABASE_URL,
  SUPABASE_KEY,
  GARMIN_SIDECAR_URL,
  GARMIN_SIDECAR_SECRET,
  GARMIN_PASSWORD_ENC_KEY,
} from "astro:env/server";

export interface ConfigStatus {
  name: string;
  configured: boolean;
  message: string;
  docsUrl?: string;
  docsLabel?: string;
}

export const configStatuses: ConfigStatus[] = [
  {
    name: "Supabase",
    configured: Boolean(SUPABASE_URL && SUPABASE_KEY),
    message: "Supabase nie jest skonfigurowany — funkcje uwierzytelniania są wyłączone.",
    docsUrl: "https://github.com/przeprogramowani/10x-astro-starter#supabase-configuration",
    docsLabel: "Zobacz instrukcję konfiguracji",
  },
  {
    name: "Garmin",
    configured: Boolean(GARMIN_SIDECAR_URL && GARMIN_SIDECAR_SECRET && GARMIN_PASSWORD_ENC_KEY),
    message: "Integracja z Garminem nie jest skonfigurowana — łączenie konta i pobieranie danych jest wyłączone.",
  },
];

export const missingConfigs = configStatuses.filter((s) => !s.configured);
