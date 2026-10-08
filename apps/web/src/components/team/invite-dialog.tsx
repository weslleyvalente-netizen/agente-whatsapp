"use client";

import { useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { apiFetch } from "@/lib/api";
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
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [userExists, setUserExists] = useState(false);
  const [invitedEmail, setInvitedEmail] = useState("");
  const [copied, setCopied] = useState(false);

  const handleSubmit = async () => {
    if (!email || !currentOrg) return;
    setLoading(true);
    setError(null);

    try {
      // The API records the invitation and, for a new person, returns a single-use link
      // (no e-mail is sent): the person opens it, chooses their own password and joins.
      const result = await apiFetch(`/organizations/${currentOrg.id}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setInviteLink(result.inviteLink ?? null);
      setUserExists(result.userExists === true);
      setInvitedEmail(email);
      setEmail("");
      setRole("agent");
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao convidar");
    } finally {
      setLoading(false);
    }
  };

  const reset = (next: boolean) => {
    setOpen(next);
    if (!next) { setInviteLink(null); setUserExists(false); setInvitedEmail(""); setCopied(false); setError(null); }
  };

  const copy = async () => {
    if (!inviteLink) return;
    try { await navigator.clipboard.writeText(inviteLink); setCopied(true); } catch { setCopied(false); }
  };

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger render={<Button />}>
        <UserPlus className="mr-2 h-4 w-4" />
        Convidar
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Convidar Membro</DialogTitle>
        </DialogHeader>
        {(inviteLink || userExists) ? (
          <div className="space-y-3">
            {inviteLink ? (
              <>
                <p className="text-sm">
                  {userExists
                    ? <><strong>{invitedEmail}</strong> já tinha um acesso. Envie este link para a pessoa definir uma nova senha e concluir o convite.</>
                    : <>Convite criado para <strong>{invitedEmail}</strong>. Envie este link para a pessoa (por exemplo, pelo WhatsApp). Ela define a própria senha e entra na organização.</>}
                </p>
                <Input readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} aria-label="Link de convite" />
                <Button onClick={copy} className="w-full">{copied ? "Link copiado" : "Copiar link"}</Button>
                <p className="text-xs text-muted-foreground">O link vale uma única vez e o convite expira em 7 dias. Trate-o como uma senha: só quem recebe deve abri-lo. Abra o link uma vez só e conclua a senha na mesma tela.</p>
              </>
            ) : (
              <p className="text-sm"><strong>{invitedEmail}</strong> já tem login. Convite registrado: é só a pessoa entrar no CRM com o e-mail e a senha dela; ela passa a fazer parte da organização automaticamente.</p>
            )}
            <Button variant="outline" onClick={() => reset(false)} className="w-full">Fechar</Button>
          </div>
        ) : (
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
            {loading ? "Gerando..." : "Gerar convite"}
          </Button>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
