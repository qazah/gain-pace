import { useState } from "react";
import type { ReactNode, SubmitEvent } from "react";
import { KeyRound, Link2, Lock, ShieldCheck, User } from "lucide-react";
import { FormField } from "@/components/auth/FormField";
import { ServerError } from "@/components/auth/ServerError";
import { Button } from "@/components/ui/button";

interface Props {
  /** Called after a session (and encrypted password) is persisted. */
  onConnected: () => void;
  /** true → framed as re-authenticating an existing connection that died. */
  reconnect?: boolean;
}

interface StatusResponse {
  status: string;
  message?: string;
}

/**
 * Two-step interactive Garmin connect: credentials → (if challenged) MFA code →
 * success. Posts to /api/garmin/connect and /api/garmin/mfa. Shows visible
 * progress because the off-edge sidecar can cold-start for a few seconds (NFR:
 * any op > 2 s must show progress).
 */
export default function ConnectGarmin({ onConnected, reconnect = false }: Props) {
  const [step, setStep] = useState<"credentials" | "mfa">("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitCredentials(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/garmin/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const json = (await res.json()) as StatusResponse;
      switch (json.status) {
        case "ok":
          onConnected();
          return;
        case "mfa_required":
          setStep("mfa");
          return;
        case "invalid_credentials":
          setError("Incorrect Garmin email or password.");
          return;
        case "not_configured":
          setError("Garmin isn't configured on the server yet.");
          return;
        default:
          setError(json.message ?? "Couldn't connect to Garmin. Please try again.");
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function submitMfa(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/garmin/mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mfaCode }),
      });
      const json = (await res.json()) as StatusResponse;
      switch (json.status) {
        case "ok":
          onConnected();
          return;
        case "mfa_invalid":
          setError("That code didn't work. Check the latest code and try again.");
          return;
        case "no_pending":
          setError("The connection attempt expired. Let's start over.");
          setStep("credentials");
          return;
        default:
          setError(json.message ?? "Couldn't verify the code. Please try again.");
      }
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setPending(false);
    }
  }

  const heading = reconnect ? "Reconnect Garmin" : "Connect your Garmin account";

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur-xl">
      <div className="mb-4 flex items-center gap-2 text-white">
        <Link2 className="size-5 text-purple-300" />
        <h2 className="text-lg font-semibold">{heading}</h2>
      </div>

      {step === "credentials" ? (
        <form onSubmit={submitCredentials} className="space-y-4" noValidate>
          <p className="text-sm text-blue-100/70">
            Sign in with your Garmin Connect credentials so GainPace can read today&apos;s workout, recent activities,
            and recovery metrics.
          </p>
          <FormField
            id="garmin-username"
            type="email"
            label="Garmin email"
            value={username}
            onChange={setUsername}
            placeholder="you@example.com"
            icon={<User className="size-4" />}
          />
          <FormField
            id="garmin-password"
            type="password"
            label="Garmin password"
            value={password}
            onChange={setPassword}
            placeholder="Your Garmin password"
            icon={<Lock className="size-4" />}
          />
          <ServerError message={error} />
          <SpinnerButton
            pending={pending}
            pendingText="Connecting to Garmin…"
            icon={<ShieldCheck className="size-4" />}
          >
            {reconnect ? "Reconnect" : "Connect"}
          </SpinnerButton>
          {pending ? (
            <p className="text-center text-xs text-blue-100/50">This can take a few seconds on the first try.</p>
          ) : null}
        </form>
      ) : (
        <form onSubmit={submitMfa} className="space-y-4" noValidate>
          <p className="text-sm text-blue-100/70">
            Garmin sent a verification code to your device. Enter it to finish connecting.
          </p>
          <FormField
            id="garmin-mfa"
            type="text"
            label="Verification code"
            value={mfaCode}
            onChange={setMfaCode}
            placeholder="123456"
            icon={<KeyRound className="size-4" />}
          />
          <ServerError message={error} />
          <SpinnerButton pending={pending} pendingText="Verifying…" icon={<ShieldCheck className="size-4" />}>
            Verify code
          </SpinnerButton>
        </form>
      )}
    </div>
  );
}

interface SpinnerButtonProps {
  pending: boolean;
  pendingText: string;
  icon: ReactNode;
  children: ReactNode;
}

function SpinnerButton({ pending, pendingText, icon, children }: SpinnerButtonProps) {
  return (
    <Button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
    >
      {pending ? (
        <span className="flex items-center gap-2">
          <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          {pendingText}
        </span>
      ) : (
        <span className="flex items-center gap-2">
          {icon}
          {children}
        </span>
      )}
    </Button>
  );
}
