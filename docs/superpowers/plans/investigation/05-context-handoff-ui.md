# Investigation: CRM context-handoff UI (items 5 & 6)

Scope: `apps/web` inbox/opportunities UI only. Read-only investigation, no DB writes, nothing modified.

## 0. Related in-progress/merged work (avoid duplicating)

- `git worktree list` shows two other active worktrees: `helena-trainer-plan` (branch `worktree-helena-trainer-plan`) and `task-detail-panel` (currently on branch `ai-disable-per-contact`).
- Remote branches of interest: `origin/tasks-inbox-ux`, `origin/tasks-panel-compact-fields`, `origin/fix/config-editor-save-race`, `origin/ai-disable-per-contact`, `origin/fix/database-missing-qualification-export` (already **merged** into `main` — commit `228bac4`, was just a build-export bug, not a UI feature).
- No `opportunities-phase1` worktree currently exists (removed already) but its work is clearly **merged into `main`**: `apps/web/src/app/(dashboard)/opportunities/page.tsx` + `opportunity-kanban.tsx` + `opportunity-edit-dialog.tsx` + `stage-change-dialog.tsx` are all present and functional on main.
- `origin/tasks-inbox-ux` and `origin/tasks-panel-compact-fields` are **not yet merged** — worth checking before building anything new in the tasks panel, since they may already contain relevant UI work. Not opened in this pass (out of scope/time); flag for whoever picks up task/inbox UI work.

## 1. What a human sees today when opening a conversation

`apps/web/src/components/inbox/`:
- `chat-panel.tsx` (240 lines) — message thread, `handleSend` (line 147) is a plain manual textarea + send button. **No auto-send / AI-suggested-draft feature exists anywhere** — confirms the user's constraint ("não gerar automaticamente mensagens") is not violated by anything already in the codebase.
- `chat-header.tsx` (159 lines) — contact name/phone, agent name, status select, assignee select, **"Assumir Conversa" / "Devolver ao Agente"** toggle (`is_human_takeover`), **"Desativar IA permanentemente" / "Reativar IA"** (`wa_contacts.ai_disabled`), "Criar tarefa" button, conversation details/close icons. So manual takeover and manual AI-return controls already exist and are wired to real state — good foundation for item 7's "atendimento humano ativo ou IA desativada: respeitar os controles existentes."
- `message-bubble.tsx` (59 lines) — labels each bubble "Agente" (AI) or "Atendente" (human) based on `role`. System messages get a centered pill. **Only `media_type === "image"` renders anything special** (an `<img>`); audio/other media types fall through to just printing `message.content` as text with no player and no "sem transcrição" indicator. Confirmed gap — matches the export agent's finding that 0 of 1,129+ audio messages have transcripts: the UI doesn't flag this to the human at all today.
- `side-panel.tsx` (61 lines) — Contact info, Tags, Internal notes (`NotesPanel`), Task history (`TaskHistoryPanel`, keyed by `contactId` only, not by opportunity). **No qualification/proposal/objection summary is rendered here.**

## 2. Context fields from the user's list — exists or not

| Item requested | Exists? | Where |
|---|---|---|
| Produto/modalidade atual | **Partial** — `opportunities.product`, `.product_model`, `.operation` exist in DB and render on the Kanban card (`opportunity-kanban.tsx:57-60`), but **not** inside the conversation view itself (side-panel doesn't join to it) |
| Orçamento/entrada/parcela | **Data exists, not surfaced in conversation view** — `conversation_qualifications` table (migration `00020`) has exactly `sale_amount`, `credit_amount`, `down_payment_amount`, `bid_amount`, `target_installment_amount`, `term_months`. Confirmed via `grep`: only consumed by `apps/api/src/routes/tasks/index.ts` and `apps/api/src/services/lead-intake.service.ts` — **zero references in `apps/web`**. This is the single best lever for item 5: the data is already captured, just never shown to the human. |
| Última proposta (fonte e data) | **Does not exist** as a field anywhere (no `last_proposal_source`/`last_proposal_at` column found on `conversation_qualifications` or `opportunities`) |
| Objeção principal | **Does not exist** as a structured field. `conversation_qualifications.commercial_notes` (free text) is the closest thing, not surfaced in UI |
| Pergunta ainda não respondida | **Does not exist** anywhere |
| Próxima ação e responsável | **Partial** — `opportunities.next_action` + `next_action_due_date` exist and render on the Kanban card (`opportunity-kanban.tsx:76-81`), but there's **no `assigned_to`/owner field visible on the card itself** (only `conversations.assigned_to` exists, at the conversation level, shown via `AssignSelect` in the chat header — not linked to the opportunity) |

## 3. Audio transcription flagging

Confirmed: `message-bubble.tsx` has no branch for `media_type === "audio"` at all — no player, no icon, no "sem transcrição" label. Given the export agent's finding of 0 real transcriptions in the DB, a human opening a conversation with voice messages currently sees either nothing or raw fallback text, with no signal that the AI never processed the audio. Straightforward, contained fix.

## 4. Suggested-next-action / objection tracking / resumption template

**Does not exist in any form**, merged or unmerged, as far as this pass could see. No component matching "suggested reply," "quick reply template," "objection tracker" found under `apps/web/src/components`. Building this is greenfield — should read from `conversation_qualifications.next_action` / `.commercial_notes` + (new) objection field rather than any freeform generation, to stay inside the "no auto-generated customer messages" constraint (it should be a human-facing prompt/hint panel, never a compose-and-send).

## 5. "Pendências de definição" queue (open negotiations without owner/next-action)

**Does not exist as a dedicated view.** The Opportunities Kanban (`apps/web/src/app/(dashboard)/opportunities/page.tsx`) is the closest existing surface — it's a real, working, per-operation Kanban with drag-and-drop stage changes that **require typed evidence** (`StageChangeDialog`, confirms the "resultado compatível com finalidade" spirit already built into stage transitions — good precedent to reuse for task completion too, see task/funnel fork's notes). It already renders `next_action`/`next_action_due_date` per card. It does **not** filter/highlight cards missing those fields, and has **0 rows in production** (opportunities table was only just deployed this session). Cheapest path to the user's ask: add a filter/badge on this existing Kanban for opportunities where `next_action IS NULL` or `next_action_due_date < now()`, rather than building a new page.

## 6. Auto-send-to-customer check (safety constraint)

**Confirmed clean.** No code path in `apps/web` or the parts of `apps/api` touched by this pass auto-generates or auto-sends a customer-facing message without a human explicitly clicking send in `chat-panel.tsx`. The only automated customer-facing sends live in the follow-up/worker subsystem (out of scope for this fork — owned by the follow-up-automation investigation).

## Summary for planning

**Biggest opportunity:** `conversation_qualifications` already captures almost everything item 5 asks for (product, amounts, term, summary, next_action, commercial_notes) but **nothing in `apps/web` reads it**. Surfacing it in `side-panel.tsx` is a well-scoped, low-risk task — the data layer is done, this is pure UI wiring.

**Second biggest opportunity:** the Opportunities Kanban already provides real drag-and-drop-with-evidence funnel management (item 6's infrastructure ask, "aproveitar a interface existente"). It needs: (a) an assignee/owner field on the card, (b) a missing-next-action filter/badge for the pendências queue, (c) linking from the conversation view to the relevant opportunity card.

**Gaps needing new fields, not just new UI:** "última proposta (fonte e data)" and "objeção principal" have no backing column anywhere — these need a schema decision before UI work (add to `conversation_qualifications` or a new event-sourced table like `conversation_qualification_events`, which already exists and is currently unused for this purpose).

**Audio:** trivial, contained UI fix — add an audio branch to `message-bubble.tsx` with a "sem transcrição" badge when no transcript is present.
