"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

type FilterTab = "all" | "mine" | "agent" | "others" | "attention";

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "mine", label: "Minhas" },
  { id: "agent", label: "Agente" },
  { id: "others", label: "Outros" },
  { id: "attention", label: "Atenção" },
];

export default function InboxPage() {
  const { currentOrg } = useOrganization();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState<string | null>(null);

  const selectedId = searchParams.get("id");

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const fetchConversations = useCallback(async () => {
    if (!currentOrg) return;
    const supabase = createClient();

    const { data } = await supabase
      .from("conversations")
      .select("*, wa_contacts(phone, name), agents(name), messages(content, created_at)")
      .eq("organization_id", currentOrg.id)
      .order("created_at", { ascending: false, referencedTable: "messages" })
      .limit(1, { referencedTable: "messages" })
      .order("last_message_at", { ascending: false });

    setConversations(data || []);
    setLoading(false);
  }, [currentOrg]);

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

  const matchesTab = (c: any) => {
    switch (filterTab) {
      case "mine":
        return userId !== null && c.assigned_to === userId;
      case "agent":
        return !c.is_human_takeover;
      case "others":
        return userId !== null && c.assigned_to !== null && c.assigned_to !== userId;
      case "attention":
        return c.is_human_takeover === true;
      default:
        return true;
    }
  };

  const filtered = conversations.filter((c) => {
    if (!matchesTab(c)) return false;
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      c.wa_contacts?.name?.toLowerCase().includes(searchLower) ||
      c.wa_contacts?.phone?.includes(search)
    );
  });

  if (loading) return <div>Carregando...</div>;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-0 -m-6">
      {/* Sidebar: Conversation List */}
      <div className="flex w-80 flex-col border-r">
        <div className="space-y-3 border-b p-3">
          <h1 className="px-1 text-lg font-heading font-semibold">Conversas</h1>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="rounded-full pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {FILTER_TABS.map((tab) => {
              const isActive = filterTab === tab.id;
              if (tab.id === "attention") {
                return (
                  <button
                    key={tab.id}
                    onClick={() => setFilterTab(tab.id)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      isActive
                        ? "border-transparent bg-lamp-rust text-white"
                        : "border-lamp-rust/40 text-lamp-rust hover:bg-lamp-rust/10"
                    )}
                  >
                    <span className={cn("h-1.5 w-1.5 rounded-full", isActive ? "bg-white" : "bg-lamp-rust")} />
                    {tab.label}
                  </button>
                );
              }
              return (
                <button
                  key={tab.id}
                  onClick={() => setFilterTab(tab.id)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "border-transparent bg-primary text-primary-foreground"
                      : "border-border bg-background text-foreground hover:bg-accent"
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
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
      <div className="flex min-w-0 flex-1 items-center justify-center text-muted-foreground">
        {selectedId ? (
          <ChatPanel conversationId={selectedId} />
        ) : (
          <p>Selecione uma conversa</p>
        )}
      </div>
    </div>
  );
}
