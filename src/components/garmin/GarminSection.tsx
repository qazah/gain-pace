import { Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useGarminData } from "@/components/hooks/useGarminData";
import ConnectGarmin from "./ConnectGarmin";
import GarminDashboard from "./GarminDashboard";

/**
 * Client island (client:load) that owns the Garmin dashboard section: fetches
 * /api/garmin/data, shows a loading state (sidecar cold start can take seconds),
 * then renders the connect flow when not connected or the data dashboard when
 * connected. A refetch runs after a successful connect / reconnect.
 */
export default function GarminSection() {
  const { data, loading, error, refetch } = useGarminData();

  function reload() {
    void refetch();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 p-8 text-blue-100/70 backdrop-blur-xl">
        <Loader2 className="size-4 animate-spin" />
        Loading your Garmin data…
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-6 text-center backdrop-blur-xl">
        <p className="text-sm text-red-300">{error}</p>
        <Button
          onClick={reload}
          className="rounded-lg bg-purple-600 px-4 py-2 font-medium text-white transition-colors hover:bg-purple-500"
        >
          <RotateCw className="size-4" />
          Retry
        </Button>
      </div>
    );
  }

  if (!data) return null;

  if (!data.connected) {
    return <ConnectGarmin onConnected={reload} />;
  }

  return <GarminDashboard data={data} onReconnect={reload} />;
}
