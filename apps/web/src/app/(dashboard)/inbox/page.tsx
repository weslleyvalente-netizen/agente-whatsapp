"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";

export default function InboxPage() {
  const { currentOrg } = useOrganization();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const selectedId = searchParams.get("id");

  const fetchConversations = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();

    let query = supabase
      .from("conversations")
      .select("*, contacts(phone, name), agents(name)")
      .eq("organization_id", currentOrg.id)
      .order("last_message_at", { ascending: false });

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const { data } = await query;
    setConversations(data || []);
    setLoading(false);
  }, [currentOrg, statusFilter]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  // Realtime updates for conversations
  useRealtime({
    table: "conversations",
    filter: currentOrg ? `organization_id=eq.${currentOrg.id}` : undefined,
    onInsert: () => fetchConversations(),
    onUpdate: () => fetchConversations(),
    enabled: !!currentOrg,
  });

  const handleSelect = (id: string) => {
    router.push(`/inbox?id=${id}`);
  };

  const filtered = conversations.filter((c) => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      c.contacts?.name?.toLowerCase().includes(searchLower) ||
      c.contacts?.phone?.includes(search)
    );
  });

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-0 -m-6">
      {/* Sidebar: Conversation List */}
      <div className="flex w-80 flex-col border-r">
        <div className="space-y-2 border-b p-3">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => v && setStatusFilter(v)}>
            <SelectTrigger>
              <SelectValue placeholder="Filtrar status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="open">Abertos</SelectItem>
              <SelectItem value="waiting">Aguardando</SelectItem>
              <SelectItem value="resolved">Resolvidos</SelectItem>
              <SelectItem value="closed">Fechados</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 overflow-y-auto">
          <ConversationList
            conversations={filtered}
            selectedId={selectedId}
            onSelect={handleSelect}
          />
        </div>
      </div>

      {/* Main: Chat Panel */}
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        {selectedId ? (
          <ChatPanel conversationId={selectedId} />
        ) : (
          <p>Selecione uma conversa</p>
        )}
      </div>
    </div>
  );
}
