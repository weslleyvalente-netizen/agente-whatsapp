"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusLamp, type LampTone } from "@/components/ui/status-lamp";
import { Radio, Phone } from "lucide-react";

interface InstanceCardProps {
  instance: {
    id: string;
    instance_name: string;
    status: string;
    phone_number: string | null;
    agents?: { id: string; name: string } | null;
  };
}

const STATUS_LAMP: Record<string, LampTone> = {
  connected: "green",
  connecting: "amber",
  disconnected: "rust",
};

const STATUS_LABEL: Record<string, string> = {
  connected: "conectada",
  connecting: "conectando",
  disconnected: "desconectada",
};

export function InstanceCard({ instance }: InstanceCardProps) {
  const tone = STATUS_LAMP[instance.status] || "off";

  return (
    <Link href={`/instances/${instance.id}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="flex flex-row items-center gap-3 pb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
            <Radio className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">{instance.instance_name}</CardTitle>
            {instance.phone_number && (
              <p className="flex items-center gap-1 text-sm text-muted-foreground tabular-data">
                <Phone className="h-3 w-3" />
                {instance.phone_number}
              </p>
            )}
          </div>
          <StatusLamp tone={tone} pulse={tone === "amber"} label={STATUS_LABEL[instance.status] || instance.status} />
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Agente: {instance.agents?.name || "Nenhum vinculado"}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}
