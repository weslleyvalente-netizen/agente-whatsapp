# Layout para celular (fases 1 a 3)

Aprovado pelo usuário em chat (2026-10-16). Motivo: o vendedor atende pelo celular e o site hoje não é responsivo (menu lateral fixo de 256 px, nenhuma classe responsiva no Inbox/funil/chat/tarefas, funil em colunas). Objetivo: atender dentro do CRM pelo celular com conforto.

## Regra de ouro
**A versão de computador (largura >= 768 px, breakpoint `md` do Tailwind) deve ficar IDÊNTICA à atual.** Todo ajuste é para telas menores. Prefira CSS puro com classes Tailwind (`md:`) a JavaScript/hooks, para evitar problemas de hidratação. Textos em português. Sem mencionar Marina/Mariana em rótulos.

## Fase 1 — estrutura (apps/web/src/app/(dashboard)/layout.tsx, components/layout/app-sidebar.tsx, app/layout.tsx)
- Abaixo de `md`: o menu lateral some; o cabeçalho ganha um botão "Menu" (ícone hambúrguer, `aria-label="Abrir menu"`) que abre o mesmo menu dentro de um painel deslizante (use o componente Sheet já existente em components/ui). Ao tocar num item, o painel fecha.
- Conteúdo principal: padding menor no celular (`p-3 md:p-6`); cabeçalho enxuto (não estourar a largura: seletor de disponibilidade e menu do usuário devem caber; abreviar rótulos se preciso).
- `export const viewport` em app/layout.tsx: `width: "device-width", initialScale: 1, viewportFit: "cover"` (e themeColor se simples). Usar `100dvh` em vez de `100vh` onde houver `h-screen` no celular (`h-dvh`), respeitando as áreas seguras (`pb-[env(safe-area-inset-bottom)]` no rodapé fixo).
- Campos de formulário com fonte >= 16px abaixo de `md` (evita o zoom automático do iOS) — via classe utilitária ou regra global em globals.css restrita a `max-width: 767px`.

## Fase 2 — Inbox estilo WhatsApp (app/(dashboard)/inbox/page.tsx, components/inbox/*)
- Abaixo de `md`: uma tela por vez. Sem conversa selecionada: só a lista de conversas, em largura total. Com conversa selecionada: só o chat, em largura total, com botão "Voltar" (seta) no cabeçalho que volta para a lista (mesmo comportamento que o `onClose` atual: `router.push("/inbox")`). No computador, continua lista + chat lado a lado como hoje.
- Chat: área de mensagens rolável ocupando a altura útil (`dvh`), campo de resposta fixo embaixo com botões de toque >= 44 px, sem ser coberto pelo teclado/barra do navegador; cabeçalho do chat compacto (nome, status, atribuição; ações secundárias em menu ou Sheet). O painel lateral (SidePanel) vira Sheet/gaveta no celular, aberto por um botão.
- Bolhas de mensagem com largura máxima adequada (ex.: `max-w-[85%]`) e imagens/áudios sem estourar a largura.

## Fase 3 — Funil e fila em lista (components/opportunities/opportunity-kanban.tsx, app/(dashboard)/opportunities/page.tsx, components/opportunities/opportunity-detail-dialog.tsx)
- Abaixo de `md`: em vez de colunas lado a lado com rolagem horizontal, os grupos/etapas ficam empilhados na vertical. Cada grupo é uma seção recolhível com título e contagem ("Pronto para assumir (3)"); o primeiro grupo com cards fica aberto por padrão, os demais fechados (ou todos abertos se for mais simples e legível — decida e documente). Cards em largura total. Manter a paginação "Mostrar mais" que já existe. O arrastar-e-soltar (dnd-kit) só faz sentido no computador: no celular desative-o (a mudança de etapa continua possível pelos botões do detalhe do card).
- Barra de filtros do funil (Fila, Contato, situação, busca, abas de funil): quebra em linhas e usa largura total; alvos de toque >= 44 px.
- Detalhe do card (OpportunityDetailDialog): no celular abre em tela cheia (altura `dvh`, sem margem), com rolagem interna; os grupos de botões ("Atendimento", "Avançar negócio", "Gerenciar") quebram em coluna ou grade de 1–2 por linha, botões de toque confortáveis; o chat embutido (grid de 2 colunas no computador) vira uma única coluna (chat abaixo, ou em gaveta).
- Os diálogos do funil (registrar ligação, congelar etc.) devem caber na tela do celular (largura `calc(100vw - 2rem)`), com os botões de ação visíveis sem rolagem horizontal.

## Fora desta entrega
Tarefas (fase 4) e PWA/notificações (fase 5). Não mexer em dados, API ou banco.

## Verificação
`pnpm --filter @aula-agente/web exec tsc --noEmit`; `next build` com `NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=dummy`; testes do shared/api continuam passando. Não é possível abrir as telas logadas; verifique por leitura do código que nenhuma classe sem prefixo altera a aparência em `md+` (compare antes/depois), e liste no relatório cada arquivo alterado e o que muda abaixo de `md`.

Commits ao final de cada fase, terminando com: Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>. Não fazer push nem abrir PR.
