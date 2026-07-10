"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import { QrCodeDialog } from "@/components/instances/qrcode-dialog";
import { InstanceStatus } from "@/components/instances/instance-status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Trash2, LogOut } from "lucide-react";
import Link from "next/link";
import type { Agent, EvolutionInstance } from "@aula-agente/shared";

export default function InstanceDetailPage() {
  const { instanceId } = useParams<{ instanceId: string }>();
  const router = useRouter();
  const [instance, setInstance] = useState<EvolutionInstance | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchData = async () => {
      const supabase = createClient();

      const { data: inst } = await supabase
        .from("evolution_instances")
        .select("*")
        .eq("id", instanceId)
        .single();
      setInstance(inst as EvolutionInstance);

      if (inst) {
        const { data: agentList } = await supabase
          .from("agents")
          .select("*")
          .eq("organization_id", inst.organization_id)
          .eq("is_active", true);
        setAgents((agentList as Agent[]) || []);
      }

      setLoading(false);
    };
    fetchData();
  }, [instanceId]);

  const handleAssignAgent = async (agentId: string) => {
    await apiFetch(`/instances/${instanceId}`, {
      method: "PATCH",
      body: JSON.stringify({
        active_agent_id: agentId === "none" ? null : agentId,
      }),
    });
    setInstance((prev) => prev ? { ...prev, active_agent_id: agentId === "none" ? null : agentId } : null);
  };

  const handleLogout = async () => {
    if (!confirm("Desconectar instancia?")) return;
    await apiFetch(`/instances/${instanceId}/logout`, { method: "POST" });
    setInstance((prev) => prev ? { ...prev, status: "disconnected" } : null);
  };

  const handleDelete = async () => {
    if (!confirm("Excluir instancia permanentemente?")) return;
    await apiFetch(`/instances/${instanceId}`, { method: "DELETE" });
    router.push("/instances");
  };

  if (loading) return <div>Carregando...</div>;
  if (!instance) return <div>Instancia nao encontrada</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/instances">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4" /></Button>
        </Link>
        <h1 className="text-2xl font-bold">{instance.instance_name}</h1>
        <InstanceStatus
          instanceId={instanceId}
          initialStatus={instance.status}
          onStatusChange={(s) => setInstance((prev) => prev ? { ...prev, status: s as EvolutionInstance["status"] } : null)}
        />
      </div>

      <Card>
        <CardHeader><CardTitle>Conexao</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Telefone</p>
              <p className="text-sm text-muted-foreground">{instance.phone_number || "Nao conectado"}</p>
            </div>
            <div className="flex gap-2">
              <QrCodeDialog instanceId={instanceId} />
              {instance.status === "connected" && (
                <Button variant="outline" onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  Desconectar
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Agente Vinculado</CardTitle></CardHeader>
        <CardContent>
          <Select
            value={instance.active_agent_id || "none"}
            onValueChange={(v) => v && handleAssignAgent(v)}
          >
            <SelectTrigger><SelectValue placeholder="Selecionar agente" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nenhum agente</SelectItem>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>{agent.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="mt-2 text-xs text-muted-foreground">
            O agente vinculado atendera as mensagens recebidas nesta instancia
          </p>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button variant="destructive" onClick={handleDelete}>
          <Trash2 className="mr-2 h-4 w-4" />
          Excluir Instancia
        </Button>
      </div>
    </div>
  );
}
