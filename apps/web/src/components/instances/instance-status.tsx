"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

interface InstanceStatusProps {
  instanceId: string;
  initialStatus: string;
  onStatusChange: (status: string) => void;
}

export function InstanceStatus({ instanceId, initialStatus, onStatusChange }: InstanceStatusProps) {
  const [status, setStatus] = useState(initialStatus);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const data = await apiFetch(`/instances/${instanceId}/status`);
      setStatus(data.status);
      onStatusChange(data.status);
    } catch {
      // ignore
    }
    setRefreshing(false);
  };

  const statusVariant: Record<string, "default" | "secondary" | "destructive"> = {
    connected: "default",
    disconnected: "destructive",
    connecting: "secondary",
  };

  return (
    <div className="flex items-center gap-2">
      <Badge variant={statusVariant[status] || "secondary"}>{status}</Badge>
      <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={refreshing}>
        <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
      </Button>
    </div>
  );
}
