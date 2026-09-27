"use client";

import { useRef, useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Trash2, Upload } from "lucide-react";
import type { AgentImageItem } from "@aula-agente/shared";

interface ImagensEditorProps {
  agentId: string;
  imagens: AgentImageItem[];
  onChange: (items: AgentImageItem[]) => void;
}

type StoredImage = { id: string; url: string; storage_path: string };

async function uploadImage(organizationId: string, agentId: string, file: File): Promise<StoredImage> {
  const formData = new FormData();
  formData.append("file", file);
  const { createClient } = await import("@/lib/supabase/client");
  const { data: { session } } = await createClient().auth.getSession();
  const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";
  const response = await fetch(`${API_URL}/organizations/${organizationId}/agents/${agentId}/config/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session?.access_token}` },
    body: formData,
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || "Falha no upload da imagem");
  }
  return response.json();
}

export function ImagensEditor({ agentId, imagens, onChange }: ImagensEditorProps) {
  const { currentOrg } = useOrganization();
  // Text fields edit local state and only save on blur, like the rest of the
  // config editor — saving per keystroke races overlapping PATCHes.
  const [items, setItems] = useState(imagens);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  // An upload can take a while; edits made meanwhile (toggle, blur-saved
  // text) must survive it, so the upload result is applied to the latest
  // list rather than the one captured when the file was picked.
  const latestItems = useRef(items);
  latestItems.current = items;

  const commit = (next: AgentImageItem[]) => {
    latestItems.current = next;
    setItems(next);
    onChange(next);
  };
  const setField = (id: string, patch: Partial<AgentImageItem>) =>
    setItems(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = replaceTarget.current;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file || !currentOrg) return;
    setBusy(target ?? "new");
    try {
      const stored = await uploadImage(currentOrg.id, agentId, file);
      if (target) {
        // Keep the item's id (it's what the prompt and the model refer to);
        // only the file behind it changes.
        commit(latestItems.current.map((i) => (i.id === target ? { ...i, url: stored.url, storage_path: stored.storage_path } : i)));
      } else {
        commit([...latestItems.current, { id: stored.id, titulo: file.name, quando_enviar: "", legenda: "", url: stored.url, storage_path: stored.storage_path, ativo: false }]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Erro no upload");
    } finally {
      setBusy(null);
      replaceTarget.current = null;
    }
  };

  const pickFile = (target: string | null) => {
    replaceTarget.current = target;
    fileInputRef.current?.click();
  };

  return (
    <div className="space-y-4">
      <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleFile} />
      {items.length === 0 && <p className="text-sm text-muted-foreground">Nenhuma imagem cadastrada.</p>}
      {items.map((img) => (
        <div key={img.id} className="flex gap-4 rounded-md border p-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={img.url} alt={img.titulo} className="h-28 w-28 shrink-0 rounded object-contain bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Input value={img.titulo} maxLength={150} placeholder="Título" onChange={(e) => setField(img.id, { titulo: e.target.value })} onBlur={() => commit(items)} />
              <div className="flex items-center gap-2">
                <Label className="text-xs">Ativa</Label>
                <Switch checked={img.ativo} onCheckedChange={(v) => commit(items.map((i) => (i.id === img.id ? { ...i, ativo: v } : i)))} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Quando enviar</Label>
              <Textarea rows={2} maxLength={500} value={img.quando_enviar} placeholder="Ex.: cliente pede o catálogo do Libera Cred" onChange={(e) => setField(img.id, { quando_enviar: e.target.value })} onBlur={() => commit(items)} />
            </div>
            <div>
              <Label className="text-xs">Legenda enviada no WhatsApp</Label>
              <Textarea rows={2} maxLength={1000} value={img.legenda} onChange={(e) => setField(img.id, { legenda: e.target.value })} onBlur={() => commit(items)} />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => pickFile(img.id)}>
                {busy === img.id ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}Trocar arquivo
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => commit(items.filter((i) => i.id !== img.id))}>
                <Trash2 className="mr-1 h-4 w-4" />Remover
              </Button>
            </div>
          </div>
        </div>
      ))}
      <Button type="button" variant="outline" disabled={busy !== null || items.length >= 20} onClick={() => pickFile(null)}>
        {busy === "new" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}Adicionar imagem
      </Button>
      <p className="text-xs text-muted-foreground">PNG, JPG ou WebP até 5 MB. Imagens novas entram desativadas; a Helena só usa depois de publicar.</p>
    </div>
  );
}
