"use client";

import { useEffect, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
import { InstanceCard } from "@/components/instances/instance-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Plus, Radio } from "lucide-react";

export default function InstancesPage() {
  const { currentOrg } = useOrganization();
  const [instances, setInstances] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const fetchInstances = async () => {
    if (!currentOrg) return;
    const data = await apiFetch(`/organizations/${currentOrg.id}/instances`);
    setInstances(data || []);
    setLoading(false);
  };

  useEffect(() => {
    fetchInstances();
  }, [currentOrg]);

  const handleCreate = async () => {
    if (!newName) return;
    setCreating(true);
    try {
      await apiFetch(`/organizations/${currentOrg!.id}/instances`, {
        method: "POST",
        body: JSON.stringify({ instance_name: newName }),
      });
      setNewName("");
      setDialogOpen(false);
      await fetchInstances();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro ao criar instancia");
    } finally {
      setCreating(false);
    }
  };

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Instancias WhatsApp</h1>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger render={<Button />}>
            <Plus className="mr-2 h-4 w-4" />
            Nova Instancia
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Criar Instancia</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Input
                placeholder="Nome da instancia"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button onClick={handleCreate} disabled={creating || !newName} className="w-full">
                {creating ? "Criando..." : "Criar"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {instances.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Radio className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">Nenhuma instancia</h3>
          <p className="text-muted-foreground">Conecte seu WhatsApp criando uma instancia</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {instances.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} />
          ))}
        </div>
      )}
    </div>
  );
}
