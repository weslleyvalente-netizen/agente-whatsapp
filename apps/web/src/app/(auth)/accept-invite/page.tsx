"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const MIN_PASSWORD = 8;

/** Opened from the single-use invite link: verifies it, lets the person choose their own password and joins the organization. */
export default function AcceptInvitePage() {
  const router = useRouter();
  const [status, setStatus] = useState<"checking" | "ready" | "invalid">("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const verified = useRef(false);

  useEffect(() => {
    // The link is single-use: guard against React strict mode running the effect twice.
    if (verified.current) return;
    verified.current = true;
    const supabase = createClient();
    const params = new URLSearchParams(window.location.search);
    const tokenHash = params.get("token_hash");
    // Links for new people are "invite"; for people who already have a login they are "recovery".
    const type = params.get("type") === "recovery" ? "recovery" : "invite";

    (async () => {
      if (tokenHash) {
        const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
        if (verifyError) { setStatus("invalid"); return; }
        window.history.replaceState(null, "", "/accept-invite");
        setStatus("ready");
        return;
      }
      const { data: { user } } = await supabase.auth.getUser();
      setStatus(user ? "ready" : "invalid");
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) { setError(`A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`); return; }
    if (password !== confirm) { setError("As senhas não conferem."); return; }
    setSaving(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      await apiFetch("/invitations/accept", { method: "POST" });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível concluir. Tente novamente.");
    } finally {
      setSaving(false);
    }
  };

  if (status === "checking") return <p className="text-center text-sm text-muted-foreground">Verificando o convite...</p>;
  if (status === "invalid") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Convite inválido ou já usado</CardTitle>
          <CardDescription>Peça um novo link a quem convidou você.</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Defina sua senha</CardTitle>
        <CardDescription>Escolha uma senha só sua para entrar no CRM.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">Senha</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={MIN_PASSWORD} required autoComplete="new-password" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirmar senha</Label>
            <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={MIN_PASSWORD} required autoComplete="new-password" />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={saving}>{saving ? "Salvando..." : "Salvar e entrar"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
