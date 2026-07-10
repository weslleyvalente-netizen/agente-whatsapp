"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { DocumentUpload } from "@/components/agents/document-upload";
import { FaqManager } from "@/components/agents/faq-manager";
import type { KnowledgeDocument, KnowledgeFaq } from "@aula-agente/shared";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function KnowledgePage() {
  const { agentId } = useParams<{ agentId: string }>();
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    const supabase = createClient();

    const [docsResult, faqsResult] = await Promise.all([
      supabase
        .from("knowledge_documents")
        .select("*")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false }),
      supabase
        .from("knowledge_faqs")
        .select("*")
        .eq("agent_id", agentId)
        .order("created_at", { ascending: false }),
    ]);

    setDocuments((docsResult.data as KnowledgeDocument[]) || []);
    setFaqs((faqsResult.data as KnowledgeFaq[]) || []);
    setLoading(false);
  }, [agentId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center gap-4">
        <Link href={`/agents/${agentId}`}>
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <h1 className="text-2xl font-bold">Base de Conhecimento</h1>
      </div>

      <DocumentUpload agentId={agentId} documents={documents} onRefresh={fetchData} />
      <FaqManager agentId={agentId} faqs={faqs} onRefresh={fetchData} />
    </div>
  );
}
