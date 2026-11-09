"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useOrganization } from "@/providers/organization-provider";
import { createClient } from "@/lib/supabase/client";
import { useRealtime } from "@/lib/realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { isUnread } from "@aula-agente/shared";
import {
  PAGE_SIZE,
  ATTENTION_CAP,
  tabFilter,
  buildSearchOr,
  loadMoreRange,
  windowRange,
  hasMore,
  appendPage,
  createGeneration,
  createLoadTracker,
  applyRefresh,
  createThrottle,
  mergeAttention,
  type TabFilter,
  type InboxTab,
} from "@/lib/inbox-query";
import { useMyRole } from "@/components/lead-distribution/use-my-role";
import { useWhatsappLayout } from "@/hooks/use-whatsapp-layout";
import { WA_THEME } from "@/lib/whatsapp-layout";

type FilterTab = InboxTab;

type ConversationRow = any;

type QueryFilter = TabFilter | { kind: "attention_takeover" } | { kind: "attention_ai_disabled" };

const SELECT_COLUMNS =
  "id, status, is_human_takeover, assigned_to, tags, last_message_at, wa_contacts!inner(id, profile_picture_path, phone, name, ai_disabled), agents(name), messages(content, created_at)";

async function runQuery(
  supabase: ReturnType<typeof createClient>,
  orgId: string,
  f: QueryFilter,
  search: string,
  finish: (q: any) => any,
): Promise<ConversationRow[]> {
  let q: any = supabase.from("conversations").select(SELECT_COLUMNS).eq("organization_id", orgId);
  switch (f.kind) {
    case "nothing":
      return [];
    case "assigned_to_me":
      q = q.eq("assigned_to", f.userId);
      break;
    case "assigned_to_me_or_unassigned":
      q = q.or(`assigned_to.eq.${f.userId},assigned_to.is.null`);
      break;
    case "ai_handling":
      q = q.eq("is_human_takeover", false).eq("wa_contacts.ai_disabled", false);
      break;
    case "assigned_to_others":
      q = q.not("assigned_to", "is", null).neq("assigned_to", f.userId);
      break;
    case "attention_takeover":
      q = q.eq("is_human_takeover", true);
      break;
    case "attention_ai_disabled":
      q = q.eq("wa_contacts.ai_disabled", true);
      break;
    default:
      break;
  }
  const searchOr = buildSearchOr(search);
  if (searchOr) q = q.or(searchOr, { referencedTable: "wa_contacts" });
  q = q
    .order("created_at", { ascending: false, referencedTable: "messages" })
    .limit(1, { referencedTable: "messages" })
    .order("last_message_at", { ascending: false })
    .order("id", { ascending: false });
  const { data, error } = await finish(q);
  if (error) throw error;
  return (data as ConversationRow[]) || [];
}

const FILTER_TABS: Array<{ id: FilterTab; label: string }> = [
  { id: "all", label: "Todas" },
  { id: "mine", label: "Minhas" },
  { id: "agent", label: "Agente" },
  { id: "others", label: "Outros" },
  { id: "attention", label: "Atenção" },
];

export default function InboxPage() {
  const { currentOrg } = useOrganization();
  const waLayout = useWhatsappLayout();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [moreAvailable, setMoreAvailable] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const [filterTab, setFilterTab] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [userId, setUserId] = useState<string | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [readMap, setReadMap] = useState<Map<string, string>>(new Map());

  const selectedId = searchParams.get("id");

  // Fase 1: filtro de tela; isolamento forte é a fase 2 (RLS)
  // Com a distribuição ligada, o vendedor (papel agent) abre a caixa já em "Minhas".
  const { role: myRole, status: roleStatus } = useMyRole();
  const distributionOn = currentOrg?.settings.lead_distribution_enabled === true;
  const [defaultedToMine, setDefaultedToMine] = useState(false);
  useEffect(() => {
    if (defaultedToMine || !distributionOn || myRole !== "agent") return;
    setDefaultedToMine(true);
    setFilterTab("mine");
  }, [defaultedToMine, distributionOn, myRole]);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      setUserId(data.user?.id ?? null);
      setUserLoaded(true);
    });
  }, []);

  // Debounce da busca (300 ms): o texto digitado só vira consulta depois da pausa.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const orgId = currentOrg?.id ?? null;
  // M3: só busca quando usuário, papel e aba padrão estão definidos — sem
  // buscar "Todas" para trocar em seguida para "Minhas".
  const ready =
    !!orgId &&
    userLoaded &&
    roleStatus !== "loading" &&
    (!(distributionOn && myRole === "agent") || defaultedToMine);
  // Chave estável: só refaz a consulta quando o filtro realmente muda.
  const filterKey = JSON.stringify(tabFilter(filterTab, { userId, distributionOn, role: myRole }));
  const filter = useMemo(() => JSON.parse(filterKey) as TabFilter, [filterKey]);
  const filterRef = useRef(filter);
  const searchRef = useRef(debouncedSearch);
  const conversationsRef = useRef<ConversationRow[]>([]);
  const moreRef = useRef(false);
  filterRef.current = filter;
  searchRef.current = debouncedSearch;
  conversationsRef.current = conversations;
  moreRef.current = moreAvailable;
  // Toda escrita na lista passa por esta geração (aba/busca, refresh, carregar mais).
  const generation = useRef(createGeneration());
  // Quem resolve `loading`: a carga inicial mais recente, não importa quem commitou.
  const loadTracker = useRef(createLoadTracker());
  const loadingRef = useRef(true);
  const unmountedRef = useRef(false);
  const skippedRefreshRef = useRef(false);
  loadingRef.current = loading;

  const loadRange = useCallback(
    async (f: TabFilter, q: string, from: number, to: number): Promise<ConversationRow[]> => {
      if (!orgId) return [];
      const supabase = createClient();
      return runQuery(supabase, orgId, f, q, (query) => query.range(from, to));
    },
    [orgId],
  );

  const loadAttention = useCallback(
    async (q: string): Promise<ConversationRow[]> => {
      if (!orgId) return [];
      const supabase = createClient();
      // Duas consultas (o PostgREST não faz OR entre conversa e contato), cada
      // uma limitada a ATTENTION_CAP; mescladas aqui. Se o conjunto crescer
      // além disso, a correção futura é uma view/RPC no banco.
      const [a, b] = await Promise.all([
        runQuery(supabase, orgId, { kind: "attention_takeover" }, q, (query) => query.limit(ATTENTION_CAP)),
        runQuery(supabase, orgId, { kind: "attention_ai_disabled" }, q, (query) => query.limit(ATTENTION_CAP)),
      ]);
      return mergeAttention(a, b);
    },
    [orgId],
  );

  // Primeira página: roda ao trocar de aba, busca, usuário ou organização.
  useEffect(() => {
    if (!ready) return;
    const gen = generation.current;
    gen.reset();
    const token = gen.begin();
    const loadId = loadTracker.current.start();
    setLoading(true);
    setLoadError(false);
    setMoreError(false);
    setLoadingMore(false);
    setConversations([]);
    setMoreAvailable(false);
    listRef.current?.scrollTo({ top: 0 });
    (async () => {
      try {
        if (filter.kind === "attention") {
          const rows = await loadAttention(debouncedSearch);
          if (gen.commit(token)) {
            setConversations(rows);
            setMoreAvailable(false);
          }
        } else {
          const rows = await loadRange(filter, debouncedSearch, 0, PAGE_SIZE - 1);
          if (gen.commit(token)) {
            setConversations(rows);
            setMoreAvailable(hasMore(rows.length));
          }
        }
      } catch {
        if (gen.commit(token)) setLoadError(true);
      } finally {
        // Resolve o loading pela carga mais recente, mesmo que um refresh
        // tenha commitado antes (ou que esta resposta tenha sido descartada).
        if (loadTracker.current.isLatest(loadId)) {
          setLoading(false);
          // eventos de tempo real ignorados durante a carga inicial
          if (skippedRefreshRef.current && !unmountedRef.current) {
            skippedRefreshRef.current = false;
            throttleRef.current?.trigger();
          }
        }
      }
    })();
  }, [ready, filter, debouncedSearch, loadRange, loadAttention, reloadTick]);

  const loadMore = async () => {
    if (loadingMore || !moreAvailable) return;
    const gen = generation.current;
    const token = gen.begin();
    setLoadingMore(true);
    setMoreError(false);
    try {
      // Offset exato = quantas linhas já estão na tela.
      const { from, to } = loadMoreRange(conversationsRef.current.length);
      const rows = await loadRange(filter, debouncedSearch, from, to);
      if (!gen.commit(token)) return; // a janela foi substituída enquanto buscava
      setConversations((prev) => appendPage(prev, rows));
      setMoreAvailable(hasMore(rows.length));
    } catch {
      if (gen.commit(token)) setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  // Tempo real: no máximo um refresh a cada ~2 s (o relógio não reinicia a cada
  // evento). Rebusca TODA a janela já carregada com os filtros atuais e
  // SUBSTITUI a lista: linhas que saíram do filtro somem e as posições
  // continuam verdadeiras (padrão: 50 linhas, ~24 KB).
  const refreshNow = useCallback(async () => {
    // Durante a carga inicial o refresh não faz nada; ela mesma reagenda ao terminar.
    if (!ready) return;
    if (loadingRef.current) {
      skippedRefreshRef.current = true;
      return;
    }
    const gen = generation.current;
    const token = gen.begin();
    const f = filterRef.current;
    const q = searchRef.current;
    try {
      if (f.kind === "attention") {
        const rows = await loadAttention(q);
        if (gen.commit(token)) {
          setConversations(rows);
          setLoadError(false);
        } else if (!unmountedRef.current) throttleRef.current?.trigger();
      } else {
        const w = windowRange(conversationsRef.current.length);
        const rows = await loadRange(f, q, w.from, w.to);
        if (gen.commit(token)) {
          const r = applyRefresh(conversationsRef.current, rows, moreRef.current);
          setConversations(r.list);
          setMoreAvailable(r.more);
          setLoadError(false);
        } else if (!unmountedRef.current) {
          throttleRef.current?.trigger();
        }
      }
    } catch {
      /* mantém a lista atual */
    }
  }, [ready, loadRange, loadAttention]);
  const refreshRef = useRef(refreshNow);
  refreshRef.current = refreshNow;
  const throttleRef = useRef<ReturnType<typeof createThrottle> | null>(null);
  if (!throttleRef.current) throttleRef.current = createThrottle(() => refreshRef.current(), 2000);
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      throttleRef.current?.cancel();
    };
  }, []);
  const scheduleRefresh = useCallback(() => throttleRef.current?.trigger(), []);

  useRealtime({
    table: "conversations",
    filter: currentOrg ? `organization_id=eq.${currentOrg.id}` : undefined,
    onInsert: scheduleRefresh,
    onUpdate: scheduleRefresh,
    enabled: !!currentOrg,
  });

  const fetchReads = useCallback(async () => {
    if (!userId) return;
    const supabase = createClient();
    // Pagina em blocos de 1000 para o PostgREST não cortar leituras em silêncio.
    const all: Array<{ conversation_id: string; last_read_at: string }> = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("conversation_reads")
        .select("conversation_id, last_read_at")
        .eq("user_id", userId)
        .order("conversation_id")
        .range(from, from + 999);
      if (error) return; // mantém o mapa anterior em vez de um parcial
      const rows = data || [];
      all.push(...rows);
      if (rows.length < 1000) break;
    }
    setReadMap(new Map(all.map((r) => [r.conversation_id, r.last_read_at])));
  }, [userId]);

  useEffect(() => {
    fetchReads();
  }, [fetchReads]);

  // Keeps this attendant's own read state in sync if they read the same
  // conversation from another tab/device.
  useRealtime({
    table: "conversation_reads",
    filter: userId ? `user_id=eq.${userId}` : undefined,
    onInsert: () => fetchReads(),
    onUpdate: () => fetchReads(),
    enabled: !!userId,
  });

  const handleSelect = (id: string) => {
    router.push(`/inbox?id=${id}`);
  };

  const withUnread = useMemo(
    () =>
      conversations.map((c) => ({
        ...c,
        // The conversation currently open in ChatPanel must never show as
        // unread, even for the instant before markAsRead()'s realtime
        // round-trip lands.
        unread: c.id === selectedId ? false : isUnread(c.last_message_at, readMap.get(c.id)),
      })),
    [conversations, readMap, selectedId],
  );

  return (
    <div className="flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] gap-0 -m-3 md:h-[calc(100vh-8rem)] md:-m-6">
      {/* Sidebar: Conversation List */}
      <div className={waLayout ? cn("w-full flex-col border-r md:flex md:w-[340px] lg:w-[380px] xl:w-[420px] md:shrink-0", WA_THEME.panel, WA_THEME.divider, selectedId ? "hidden" : "flex") : cn("w-full flex-col border-r md:flex md:w-80", selectedId ? "hidden" : "flex")}>
        <div className={waLayout ? cn("space-y-3 border-b p-3", WA_THEME.divider) : "space-y-3 border-b p-3"}>
          <h1 className="px-1 text-lg font-heading font-semibold">Conversas</h1>
          <div className="relative">
            <Search className={waLayout ? "absolute left-2.5 top-3.5 h-4 w-4 text-muted-foreground md:top-2.5" : "absolute left-2 top-3.5 h-4 md:top-2.5 w-4 text-muted-foreground"} />
            <Input
              placeholder="Buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className={waLayout ? cn("h-11 rounded-lg border-transparent pl-8 md:h-9", WA_THEME.search) : "h-11 rounded-full pl-8 md:h-8"}
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
                      "flex items-center gap-1.5 rounded-full border px-3 py-2 text-xs md:py-1 font-medium transition-colors",
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
                  className={waLayout ? cn(
                    "rounded-full border border-transparent px-3 py-2 text-xs font-medium transition-colors md:py-1",
                    isActive
                      ? "bg-[#d9fdd3] text-[#008069] dark:bg-[#0a332c] dark:text-[#00a884]"
                      : "bg-[#f0f2f5] text-[#54656f] hover:bg-[#e9edef] dark:bg-[#202c33] dark:text-[#8696a0] dark:hover:bg-[#2a3942]"
                  ) : cn(
                    "rounded-full border px-3 py-2 text-xs font-medium transition-colors md:py-1",
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
        <div ref={listRef} className="flex-1 overflow-y-auto">
          <ConversationList
            conversations={withUnread}
            selectedId={selectedId}
            onSelect={handleSelect}
            loading={loading}
            error={loadError}
            onRetry={() => setReloadTick((n) => n + 1)}
            moreError={moreError}
            hasMore={moreAvailable}
            loadingMore={loadingMore}
            onLoadMore={loadMore}
            waLayout={waLayout}
          />
        </div>
      </div>

      {/* Main: Chat Panel */}
      <div className={waLayout ? cn("min-w-0 flex-1 items-center justify-center text-muted-foreground md:flex", !selectedId && WA_THEME.header, selectedId ? "flex" : "hidden") : cn("min-w-0 flex-1 items-center justify-center text-muted-foreground md:flex", selectedId ? "flex" : "hidden")}>
        {selectedId ? (
          <ChatPanel key={selectedId} conversationId={selectedId} />
        ) : waLayout ? (
          <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center">
            <p className={cn("text-2xl font-light", WA_THEME.title)}>Conversas</p>
            <p className={cn("text-sm", WA_THEME.meta)}>Selecione uma conversa na lista para ver as mensagens e responder.</p>
          </div>
        ) : (
          <p>Selecione uma conversa</p>
        )}
      </div>
    </div>
  );
}
