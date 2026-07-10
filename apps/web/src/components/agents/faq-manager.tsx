"use client";

import { useState } from "react";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2 } from "lucide-react";
import type { KnowledgeFaq } from "@aula-agente/shared";

interface FaqManagerProps {
  agentId: string;
  faqs: KnowledgeFaq[];
  onRefresh: () => void;
}

export function FaqManager({ agentId, faqs, onRefresh }: FaqManagerProps) {
  const { currentOrg } = useOrganization();
  const [showForm, setShowForm] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!currentOrg || !question || !answer) return;
    setSaving(true);

    const supabase = createClient();
    await supabase.from("knowledge_faqs").insert({
      agent_id: agentId,
      organization_id: currentOrg.id,
      question,
      answer,
      is_active: true,
    });

    setQuestion("");
    setAnswer("");
    setShowForm(false);
    setSaving(false);
    onRefresh();
  };

  const handleToggle = async (faqId: string, isActive: boolean) => {
    const supabase = createClient();
    await supabase.from("knowledge_faqs").update({ is_active: isActive }).eq("id", faqId);
    onRefresh();
  };

  const handleDelete = async (faqId: string) => {
    if (!confirm("Excluir FAQ?")) return;
    const supabase = createClient();
    await supabase.from("knowledge_faqs").delete().eq("id", faqId);
    onRefresh();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>FAQs</CardTitle>
        <Button size="sm" onClick={() => setShowForm(!showForm)}>
          <Plus className="mr-2 h-4 w-4" />
          Adicionar FAQ
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {showForm && (
          <div className="space-y-3 rounded-md border p-4">
            <Input
              placeholder="Pergunta"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <Textarea
              placeholder="Resposta"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
            />
            <div className="flex gap-2">
              <Button onClick={handleAdd} disabled={saving || !question || !answer} size="sm">
                {saving ? "Salvando..." : "Salvar"}
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)} size="sm">
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {faqs.length === 0 && !showForm ? (
          <p className="text-sm text-muted-foreground">Nenhuma FAQ cadastrada</p>
        ) : (
          <div className="space-y-2">
            {faqs.map((faq) => (
              <div key={faq.id} className="rounded-md border p-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <p className="text-sm font-medium">{faq.question}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{faq.answer}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={faq.is_active}
                      onCheckedChange={(v) => handleToggle(faq.id, v)}
                    />
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(faq.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
