"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocumentUpload } from "@/components/agents/document-upload";
import { FaqManager } from "@/components/agents/faq-manager";
import { ListEditor } from "./list-editor";
import type { AgentConfigDraft, AgentKnowledgeConfig, KnowledgeDocument, KnowledgeFaq } from "@aula-agente/shared";

export type ConhecimentoItemKey = "documentos" | "faq" | "precos" | "links";

interface ConhecimentoSectionProps {
  agentId: string;
  draft: AgentConfigDraft;
  onPatch: (patch: { knowledge: AgentKnowledgeConfig }) => Promise<void>;
  item: ConhecimentoItemKey;
}

export function ConhecimentoSection({ agentId, draft, onPatch, item }: ConhecimentoSectionProps) {
  const [knowledge, setKnowledge] = useState(draft.knowledge);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);

  const fetchDocsAndFaqs = useCallback(async () => {
    const supabase = createClient();
    const [docsResult, faqsResult] = await Promise.all([
      supabase.from("knowledge_documents").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }),
      supabase.from("knowledge_faqs").select("*").eq("agent_id", agentId).order("created_at", { ascending: false }),
    ]);
    setDocuments((docsResult.data as KnowledgeDocument[]) || []);
    setFaqs((faqsResult.data as KnowledgeFaq[]) || []);
  }, [agentId]);

  useEffect(() => {
    fetchDocsAndFaqs();
  }, [fetchDocsAndFaqs]);

  const save = (next: AgentKnowledgeConfig) => {
    setKnowledge(next);
    onPatch({ knowledge: next });
  };

  if (item === "documentos") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Base de Conhecimento</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Ativa para este agente</Label>
            <Switch checked={knowledge.documentos_ativos} onCheckedChange={(v) => save({ ...knowledge, documentos_ativos: v })} />
          </div>
          <DocumentUpload agentId={agentId} documents={documents} onRefresh={fetchDocsAndFaqs} />
        </CardContent>
      </Card>
    );
  }

  if (item === "faq") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>FAQ</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Ativa para este agente</Label>
            <Switch checked={knowledge.faqs_ativas} onCheckedChange={(v) => save({ ...knowledge, faqs_ativas: v })} />
          </div>
          <FaqManager agentId={agentId} faqs={faqs} onRefresh={fetchDocsAndFaqs} />
        </CardContent>
      </Card>
    );
  }

  if (item === "precos") {
    return (
      <Card>
        <CardHeader><CardTitle>Preços</CardTitle></CardHeader>
        <CardContent>
          <Textarea
            rows={6}
            value={knowledge.precos_notas}
            placeholder="Notas de preço sempre visíveis para o agente (faixas de referência, condições gerais)."
            onChange={(e) => setKnowledge({ ...knowledge, precos_notas: e.target.value })}
            onBlur={() => save(knowledge)}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Links</CardTitle></CardHeader>
      <CardContent>
        <ListEditor
          items={knowledge.links}
          titleKey="titulo"
          fields={[
            { key: "titulo", label: "Título", type: "text" },
            { key: "url", label: "URL", type: "text" },
          ]}
          emptyItem={() => ({ id: crypto.randomUUID(), titulo: "", url: "", ativo: true })}
          onChange={(items) => save({ ...knowledge, links: items })}
          addLabel="+ Novo link"
        />
      </CardContent>
    </Card>
  );
}
