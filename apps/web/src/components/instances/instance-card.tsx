"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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

export function InstanceCard({ instance }: InstanceCardProps) {
  const statusVariant: Record<string, "default" | "secondary" | "destructive"> = {
    connected: "default",
    disconnected: "destructive",
    connecting: "secondary",
  };

  return (
    <Link href={`/instances/${instance.id}`}>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader className="flex flex-row items-center gap-3 pb-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
            <Radio className="h-5 w-5 text-green-500" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-base">{instance.instance_name}</CardTitle>
            {instance.phone_number && (
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                <Phone className="h-3 w-3" />
                {instance.phone_number}
              </p>
            )}
          </div>
          <Badge variant={statusVariant[instance.status] || "secondary"}>
            {instance.status}
          </Badge>
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
