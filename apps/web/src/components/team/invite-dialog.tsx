"use client";

import { useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { UserPlus } from "lucide-react";

const ROLE_LABELS: Record<string, string> = { admin: "Admin", agent: "Agente" };

interface InviteDialogProps {
  onInvited: () => void;
}

export function InviteDialog({ onInvited }: InviteDialogProps) {
  const { currentOrg } = useOrganization();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<string>("agent");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!email || !currentOrg) return;
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const { error: insertError } = await supabase
        .from("organization_invitations")
        .insert({
          organization_id: currentOrg.id,
          email,
          role,
          invited_by: user!.id,
          status: "pending",
          expires_at: expiresAt,
        });

      if (insertError) throw insertError;

      setEmail("");
      setRole("agent");
      setOpen(false);
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao convidar");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <UserPlus className="mr-2 h-4 w-4" />
        Convidar
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar Membro</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="email@exemplo.com"
            />
          </div>
          <div className="space-y-2">
            <Label>Funcao</Label>
            <Select value={role} onValueChange={(v) => v && setRole(v)}>
              <SelectTrigger>
                <SelectValue>{(value: string) => ROLE_LABELS[value] ?? value}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="agent">Agente</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleSubmit} disabled={loading || !email} className="w-full">
            {loading ? "Enviando..." : "Enviar Convite"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
