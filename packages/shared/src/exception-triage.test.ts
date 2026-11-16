import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_CALENDAR, type BusinessCalendar } from "./business-calendar.js";
import {
  isClosingAcknowledgement, buildExceptionAlertMessage, classifyHumanReply, classifyTriage, exceptionAlertDueAt, exceptionAlertRecipients, isResolutionEvent, planExceptionAlerts,
  checkNoActionClosure, evaluateAlertReadiness, recipientEligibleStages, NO_ACTION_WAITING_JUSTIFICATIONS, MIN_WAITING_JUSTIFICATION_NOTE,
  type AlertPlanInput, type TriageInput,
} from "./exception-triage.js";

// 2026-11-16 é segunda. America/Sao_Paulo = UTC-3. Calendário padrão: seg-sex 08:00-18:00.
const at = (iso: string) => new Date(iso);
const CAL: BusinessCalendar = DEFAULT_BUSINESS_CALENDAR;

describe("classifyHumanReply (casos reais da auditoria de 16/11)", () => {
  it.each([
    ["Bom dia", "saudacao"],
    ["Bom dia Wellington tudo bem ?", "saudacao"],
    ["Oi, Cristiane, tudo bem?", "saudacao"],
    ["Boa tarde, Gustavo! Tudo bem? 😊", "saudacao"],
    ["Bom dia Edvania tudo bem ?", "saudacao"],
    ["ok", "saudacao"],
    ["temos sim cartas já contempladas, posso te enviar as opções?", "comercial"],
    ["qual valor de entrada possui ?", "comercial"],
    ["no estoque temos a TTR que também é uma boa opção", "comercial"],
    ["Bom dia Janaina tudo bem ? qual valor de entrada possui p", "comercial"],
  ])("%s => %s", (text, expected) => expect(classifyHumanReply(text)).toBe(expected));
  it("mídia e vazio nunca contam como resposta comercial", () => {
    expect(classifyHumanReply("[audio]")).toBe("midia");
    expect(classifyHumanReply("[imagem] foto")).toBe("midia");
    expect(classifyHumanReply(null)).toBe("midia");
    expect(classifyHumanReply("   ")).toBe("midia");
  });
});

const base = (over: Partial<TriageInput> = {}): TriageInput => ({
  kind: "exception", anchorAt: "2026-11-13T16:18:00Z", flaggedAt: "2026-11-13T17:30:00Z",
  humanReplies: [], lastMessage: null, resolvedEvent: null, conversationStatus: "waiting", hasOpenOpportunity: true,
  now: at("2026-11-16T14:00:00Z"), calendar: CAL, ...over,
});

describe("classifyTriage: exceções", () => {
  it("4bbadd05: só saudação e o cliente escreveu por último => urgente, cliente aguardando", () => {
    const r = classifyTriage(base({ humanReplies: [{ content: "Bom dia", at: "2026-11-13T16:40:00Z" }], lastMessage: { role: "contact", at: "2026-11-14T12:06:00Z" } }));
    expect(r).toMatchObject({ state: "aguardando_atendimento_comercial", group: "urgente", clientWaiting: true, hasCommercialReply: false, waitingSince: "2026-11-14T12:06:00Z" });
  });
  it("813e7979: duas saudações, última mensagem humana => ainda urgente (sem conteúdo comercial)", () => {
    const r = classifyTriage(base({ humanReplies: [{ content: "Bom dia", at: "2026-11-16T13:52:00Z" }, { content: "tudo bem?", at: "2026-11-16T13:53:00Z" }], lastMessage: { role: "human_agent", at: "2026-11-16T13:53:00Z" } }));
    expect(r).toMatchObject({ state: "aguardando_atendimento_comercial", group: "urgente", clientWaiting: false, hasCommercialReply: false });
  });
  it("6b8e4c32: resposta comercial mas o cliente respondeu depois => urgente (cliente aguardando)", () => {
    const r = classifyTriage(base({ humanReplies: [{ content: "Bom dia Edvania tudo bem ?", at: "2026-11-16T13:51:00Z" }, { content: "o consórcio de 60 a 70 mil, qual parcela você prefere?", at: "2026-11-16T13:52:00Z" }], lastMessage: { role: "contact", at: "2026-11-16T13:56:00Z" } }));
    expect(r).toMatchObject({ state: "aguardando_atendimento_comercial", group: "urgente", clientWaiting: true, hasCommercialReply: true });
  });
  it("ded5ffdf: resposta comercial e a bola com o cliente => respondida sem aceite formal", () => {
    const r = classifyTriage(base({ humanReplies: [{ content: "temos sim cartas já contempladas, posso te enviar as opções?", at: "2026-11-14T13:08:00Z" }], lastMessage: { role: "human_agent", at: "2026-11-14T13:09:00Z" } }));
    expect(r).toMatchObject({ state: "respondida_sem_aceite", group: "respondida", needsOwnerConfirmation: true, commercialReplyCount: 1 });
  });
  it("evento resolved_* encerra: estado resolvida, fora das listas", () => {
    const r = classifyTriage(base({ resolvedEvent: { kind: "resolved_confirmed", at: "2026-11-16T14:00:00Z" } }));
    expect(r).toMatchObject({ state: "resolvida", group: null });
  });
  it("o atraso acumulado vem do primeiro handoff, não da criação da exceção", () => {
    const r = classifyTriage(base());
    expect(r.accumulatedWallMinutes).toBeGreaterThan(r.sinceFlaggedWallMinutes);
    expect(r.accumulatedBusinessMinutes).toBeGreaterThan(r.sinceFlaggedBusinessMinutes);
    // sex 13:18 -> seg 11:00 em expediente 08-18: 4h42 (sex) + 3h00 (seg) = 462 min
    expect(r.accumulatedBusinessMinutes).toBe(462);
  });
});

describe("classifyTriage: atribuições alert vencidas", () => {
  const alert = (over: Partial<TriageInput> = {}) => base({ kind: "alert", anchorAt: "2026-10-13T15:00:00Z", flaggedAt: "2026-10-13T16:00:00Z", ...over });
  it("cliente escreveu e nunca foi respondido => urgente (ex.: c81c9c40)", () => {
    expect(classifyTriage(alert({ lastMessage: { role: "contact", at: "2026-10-29T12:00:00Z" } }))).toMatchObject({ group: "urgente", clientWaiting: true });
  });
  it("34 dias, sem resposta, cliente não aguarda => obsoleta", () => {
    expect(classifyTriage(alert({ lastMessage: { role: "agent", at: "2026-10-13T15:30:00Z" } }))).toMatchObject({ state: "obsoleta", group: "obsoleta" });
  });
  it("conversa encerrada ou sem negócio aberto => obsoleta mesmo se recente", () => {
    const recent = { flaggedAt: "2026-11-14T10:00:00Z", anchorAt: "2026-11-14T09:00:00Z", lastMessage: { role: "agent", at: "2026-11-14T09:30:00Z" } };
    expect(classifyTriage(alert({ ...recent, conversationStatus: "resolved" })).group).toBe("obsoleta");
    expect(classifyTriage(alert({ ...recent, hasOpenOpportunity: false })).group).toBe("obsoleta");
  });
  it("recente, negócio aberto, sem resposta e cliente não aguarda => segue urgente (conservador: não esconde)", () => {
    const r = classifyTriage(alert({ flaggedAt: "2026-11-14T10:00:00Z", anchorAt: "2026-11-14T09:00:00Z", lastMessage: { role: "human_agent", at: "2026-11-13T10:00:00Z" } }));
    expect(r.group).toBe("urgente");
  });
  it("resposta comercial desde a atribuição => respondida", () => {
    expect(classifyTriage(alert({ humanReplies: [{ content: "posso te passar a simulação completa agora", at: "2026-10-13T16:10:00Z" }], lastMessage: { role: "human_agent", at: "2026-10-13T16:10:00Z" } })).group).toBe("respondida");
  });
});

const plan = (over: Partial<AlertPlanInput> = {}): AlertPlanInput => ({
  mode: "on", exceptionAt: at("2026-11-16T14:00:00Z"), now: at("2026-11-16T14:00:00Z"), calendar: CAL, recordedStages: [], resolved: false,
  activatedAt: at("2026-11-16T10:00:00Z"), ...over,
});

describe("planExceptionAlerts: escada 0/15/30/60 minutos úteis", () => {
  it("estágio 0 é imediato", () => {
    expect(planExceptionAlerts(plan())).toMatchObject({ send: { stage: 0 }, skip: [], reason: null });
  });
  it("não repete estágio já registrado e espera o próximo vencer (14 min = nada; 15 min = estágio 15)", () => {
    expect(planExceptionAlerts(plan({ recordedStages: [0], now: at("2026-11-16T14:14:00Z") })).reason).toBe("nothing_due");
    expect(planExceptionAlerts(plan({ recordedStages: [0], now: at("2026-11-16T14:15:00Z") }))).toMatchObject({ send: { stage: 15 } });
  });
  it("conta minutos ÚTEIS: exceção às 17:50 só atinge 15 min úteis na manhã seguinte", () => {
    const exceptionAt = at("2026-11-16T20:50:00Z"); // seg 17:50 BRT
    expect(exceptionAlertDueAt(exceptionAt, 15, CAL).toISOString()).toBe("2026-11-17T11:05:00.000Z"); // ter 08:05 BRT (10 min no dia + 5 no seguinte)
    expect(planExceptionAlerts(plan({ exceptionAt, recordedStages: [0], now: at("2026-11-16T22:00:00Z") })).reason).toBe("nothing_due");
    expect(planExceptionAlerts(plan({ exceptionAt, recordedStages: [0], now: at("2026-11-17T11:05:00Z") }))).toMatchObject({ send: { stage: 15 } });
  });
  it("estágios 30 e 60 nos instantes certos", () => {
    expect(planExceptionAlerts(plan({ recordedStages: [0, 15], now: at("2026-11-16T14:30:00Z") }))).toMatchObject({ send: { stage: 30 } });
    expect(planExceptionAlerts(plan({ recordedStages: [0, 15, 30], now: at("2026-11-16T14:59:00Z") })).reason).toBe("nothing_due");
    expect(planExceptionAlerts(plan({ recordedStages: [0, 15, 30], now: at("2026-11-16T15:00:00Z") }))).toMatchObject({ send: { stage: 60 } });
  });
  it("worker parado: envia só o estágio mais alto vencido e marca os anteriores como pulados (sem enxurrada)", () => {
    const p = planExceptionAlerts(plan({ now: at("2026-11-16T15:10:00Z") }));
    expect(p.send?.stage).toBe(60);
    expect(p.skip).toEqual([0, 15, 30]);
  });
  it("tudo registrado => nada", () => {
    expect(planExceptionAlerts(plan({ recordedStages: [0, 15, 30, 60], now: at("2026-11-17T20:00:00Z") })).reason).toBe("nothing_due");
  });
  it("resolução válida cancela as cobranças", () => {
    expect(planExceptionAlerts(plan({ resolved: true, recordedStages: [0], now: at("2026-11-16T15:30:00Z") }))).toMatchObject({ send: null, reason: "resolved" });
  });
  it("sem retroativo: exceção criada antes da ativação nunca avisa; sem ativação nada é enviado; modo off nada", () => {
    expect(planExceptionAlerts(plan({ exceptionAt: at("2026-11-16T09:00:00Z"), activatedAt: at("2026-11-16T10:00:00Z") })).reason).toBe("before_activation");
    expect(planExceptionAlerts(plan({ activatedAt: null })).reason).toBe("not_activated");
    expect(planExceptionAlerts(plan({ mode: "off" })).reason).toBe("mode_off");
  });
  it("shadow planeja igual a on (a diferença é só não enviar)", () => {
    expect(planExceptionAlerts(plan({ mode: "shadow" })).send?.stage).toBe(0);
  });
});

describe("destinatários e texto", () => {
  it("0/15/30 vão a gestores e vendedores; 60 só a gestores; sem gestor configurado nunca cai em fallback", () => {
    expect(exceptionAlertRecipients(15, ["g"], ["a", "b"]).sort()).toEqual(["a", "b", "g"]);
    expect(exceptionAlertRecipients(60, ["g"], ["a", "b"])).toEqual(["g"]);
    expect(exceptionAlertRecipients(60, [], ["a", "b"])).toEqual([]);
    expect(exceptionAlertRecipients(0, ["a"], ["a", "b"]).sort()).toEqual(["a", "b"]);
  });
  it("a mensagem preserva o handoff original e o atraso acumulado, sem dado do cliente", () => {
    const m = buildExceptionAlertMessage(60, { anchorAt: "2026-11-13T16:18:00Z", accumulatedBusinessMinutes: 462, accumulatedWallMinutes: 4000, timeZone: "America/Sao_Paulo" });
    expect(m.severity).toBe("critical");
    expect(m.body).toContain("13/11");
    expect(m.body).toContain("7 h 42 min úteis");
    expect(m.title).toMatch(/CRÍTICO/);
    expect(JSON.stringify(m)).not.toMatch(/\d{8,}/); // nenhum telefone
  });
  it("só resolved_* é resolução; reconhecer não cancela cobrança", () => {
    expect(isResolutionEvent("resolved_confirmed")).toBe(true);
    expect(isResolutionEvent("resolved_no_action")).toBe(true);
    expect(isResolutionEvent("acknowledged")).toBe(false);
  });
});

describe("cortesia de encerramento não conta como cliente esperando (casos reais)", () => {
  it.each([["Blz", true], ["Obrigada", true], ["tá bom, muito obrigado", true], ["ok", true], ["👍", true], ["Sim", false], ["Mais pra frente", false], ["60mil", false], ["Bom-dia", false], ["me liga", false], ["", false]])("%s => %s", (t, expected) =>
    expect(isClosingAcknowledgement(t)).toBe(expected));
  const base = (over: Partial<TriageInput>): TriageInput => ({
    kind: "exception", anchorAt: "2026-11-13T16:18:00Z", flaggedAt: "2026-11-13T17:30:00Z", humanReplies: [], lastMessage: null, resolvedEvent: null,
    conversationStatus: "waiting", hasOpenOpportunity: true, now: at("2026-11-16T14:00:00Z"), calendar: CAL, ...over,
  });
  it("4bbadd05 (Gui): áudio do vendedor e o cliente respondeu 'Blz' => cliente NÃO está esperando; segue urgente por falta de conteúdo comercial verificável, sinalizado como mídia", () => {
    const r = classifyTriage(base({ humanReplies: [{ content: "[audio]", at: "2026-11-14T12:03:00Z" }], lastMessage: { role: "contact", at: "2026-11-14T12:06:00Z", content: "Blz" } }));
    expect(r).toMatchObject({ clientWaiting: false, state: "aguardando_atendimento_comercial", group: "urgente", lastReplyClass: "midia", hasCommercialReply: false });
  });
  it("sem resposta humana nenhuma, até um 'ok' do cliente continua esperando (a última palavra do atendimento é do cliente)", () => {
    expect(classifyTriage(base({ lastMessage: { role: "contact", at: "2026-11-14T12:06:00Z", content: "ok" } })).clientWaiting).toBe(true);
  });
  it("6b8e4c32 (Edivan): '60mil' depois da pergunta do vendedor => esperando", () => {
    const r = classifyTriage(base({ humanReplies: [{ content: "qual valor de crédito que precisa pra carta contemplada ?", at: "2026-11-16T13:52:00Z" }], lastMessage: { role: "contact", at: "2026-11-16T13:56:00Z", content: "60mil" } }));
    expect(r).toMatchObject({ clientWaiting: true, group: "urgente" });
  });
  it("c81c9c40 (Larissa): 'Obrigada' depois da resposta humana => não está esperando; vai para respondidas, não para urgentes", () => {
    const r = classifyTriage(base({ kind: "alert", anchorAt: "2026-10-29T12:00:00Z", flaggedAt: "2026-10-29T13:00:00Z", humanReplies: [{ content: "nesse contato pra falar com o financeiro", at: "2026-10-29T12:32:00Z" }], lastMessage: { role: "contact", at: "2026-10-29T12:32:30Z", content: "Obrigada" } }));
    expect(r.clientWaiting).toBe(false);
    expect(r.group).toBe("respondida");
  });
});

// ---------- Correções da revisão do PR #102 ----------

describe("planExceptionAlerts: elegibilidade por destinatário (item 1)", () => {
  const base = { mode: "on" as const, exceptionAt: at("2026-11-16T14:00:00Z"), now: at("2026-11-16T15:30:00Z"), calendar: CAL, recordedStages: [] as number[], resolved: false, activatedAt: at("2026-11-16T09:00:00Z") };
  it("vendedor (sem o 60) com tudo devido recebe o 30, nunca o crítico", () => {
    const p = planExceptionAlerts({ ...base, eligibleStages: recipientEligibleStages(false) });
    expect(p.send?.stage).toBe(30);
    expect(p.skip).toEqual([0, 15]);
  });
  it("gestor recebe o 60", () => {
    expect(planExceptionAlerts({ ...base, eligibleStages: recipientEligibleStages(true) }).send?.stage).toBe(60);
  });
  it("o que já foi registrado PARA O DESTINATÁRIO é descontado; o dos outros não importa", () => {
    expect(planExceptionAlerts({ ...base, now: at("2026-11-16T14:15:00Z"), recordedStages: [0] }).send?.stage).toBe(15);
    expect(planExceptionAlerts({ ...base, now: at("2026-11-16T14:15:00Z"), recordedStages: [] }).send?.stage).toBe(15);
  });
  it("recipientEligibleStages: gestor [0,15,30,60]; vendedor [0,15,30]", () => {
    expect(recipientEligibleStages(true)).toEqual([0, 15, 30, 60]);
    expect(recipientEligibleStages(false)).toEqual([0, 15, 30]);
  });
});

describe("checkNoActionClosure: 'sem ação' com cliente aguardando (item 4)", () => {
  const LONG = "Cliente atendido por telefone na loja hoje";
  it("cliente NÃO aguardando: basta a nota", () => {
    expect(checkNoActionClosure({ clientWaiting: false, note: "duplicado" })).toEqual({ ok: true, note: "duplicado" });
    expect(checkNoActionClosure({ clientWaiting: false, note: "  " })).toMatchObject({ ok: false, code: "note_too_short" });
  });
  it("cliente aguardando sem justificativa: recusa", () => {
    expect(checkNoActionClosure({ clientWaiting: true, note: LONG })).toMatchObject({ ok: false, code: "client_waiting" });
    expect(checkNoActionClosure({ clientWaiting: true, justification: "porque sim", note: LONG })).toMatchObject({ ok: false, code: "client_waiting" });
    expect(checkNoActionClosure({ clientWaiting: true, justification: null, note: LONG })).toMatchObject({ ok: false, code: "client_waiting" });
  });
  it("justificativa da lista mas nota curta: recusa", () => {
    expect(checkNoActionClosure({ clientWaiting: true, justification: "cliente_desistiu", note: "x".repeat(MIN_WAITING_JUSTIFICATION_NOTE - 1) })).toMatchObject({ ok: false, code: "note_too_short" });
    // espaços nas pontas não contam
    expect(checkNoActionClosure({ clientWaiting: true, justification: "cliente_desistiu", note: `  ${"x".repeat(MIN_WAITING_JUSTIFICATION_NOTE - 1)}  ` })).toMatchObject({ ok: false });
  });
  it.each(NO_ACTION_WAITING_JUSTIFICATIONS)("justificativa %s + nota suficiente: aceita e grava a justificativa na nota", j => {
    expect(checkNoActionClosure({ clientWaiting: true, justification: j, note: LONG })).toEqual({ ok: true, note: `[cliente aguardando: ${j}] ${LONG}` });
  });
});

describe("evaluateAlertReadiness: destinatário administrativo e canal funcional (item 5)", () => {
  const ok = { userId: "g", memberRole: "owner", pushDevices: 1 };
  it("pronto: push configurado + gestor membro (owner/admin) com aparelho", () => {
    expect(evaluateAlertReadiness({ pushConfigured: true, recipients: [ok] })).toEqual({ ready: true, validManagerCount: 1, problems: [] });
    expect(evaluateAlertReadiness({ pushConfigured: true, recipients: [{ ...ok, memberRole: "admin" }] }).ready).toBe(true);
  });
  it("sem destinatários", () => {
    expect(evaluateAlertReadiness({ pushConfigured: true, recipients: [] })).toMatchObject({ ready: false, problems: ["no_recipients"] });
  });
  it("push não configurado no servidor", () => {
    expect(evaluateAlertReadiness({ pushConfigured: false, recipients: [ok] })).toMatchObject({ ready: false, problems: ["push_not_configured"] });
  });
  it("destinatário sem aparelho", () => {
    const r = evaluateAlertReadiness({ pushConfigured: true, recipients: [{ ...ok, pushDevices: 0 }] });
    expect(r.ready).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(["recipient_without_device", "no_valid_manager"]));
  });
  it("destinatário que saiu da organização ou é só vendedor não conta", () => {
    expect(evaluateAlertReadiness({ pushConfigured: true, recipients: [{ ...ok, memberRole: null }] }).problems).toEqual(expect.arrayContaining(["recipient_not_member", "no_valid_manager"]));
    expect(evaluateAlertReadiness({ pushConfigured: true, recipients: [{ ...ok, memberRole: "agent" }] }).problems).toEqual(expect.arrayContaining(["recipient_not_admin", "no_valid_manager"]));
  });
  it("um gestor válido basta mesmo com outro destinatário inválido na lista (mas o problema é reportado)", () => {
    const r = evaluateAlertReadiness({ pushConfigured: true, recipients: [ok, { userId: "v", memberRole: "agent", pushDevices: 3 }] });
    expect(r.ready).toBe(true);
    expect(r.validManagerCount).toBe(1);
    expect(r.problems).toContain("recipient_not_admin");
  });
});
