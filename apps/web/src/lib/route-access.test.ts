import { describe, expect, it } from "vitest";
import { guardDecision, isManagerOnlyPath, isManagerRole, SELLER_HOME } from "./route-access";
import { visibleNavigation } from "../components/layout/nav-items";
import { NOTIFICATIONS_HREF, USER_MENU_LINKS } from "../components/layout/user-menu-items";

describe("isManagerRole", () => {
  it("só owner e admin são gestores", () => {
    expect(isManagerRole("owner")).toBe(true);
    expect(isManagerRole("admin")).toBe(true);
    expect(isManagerRole("agent")).toBe(false);
    expect(isManagerRole(null)).toBe(false);
  });
});

describe("isManagerOnlyPath", () => {
  it.each(["/agents", "/agents/new", "/agents/abc/knowledge", "/instances", "/instances/x", "/costs", "/team", "/settings", "/calls"])("%s é restrita", (p) => {
    expect(isManagerOnlyPath(p)).toBe(true);
  });
  it.each(["/", "/inbox", "/inbox/123", "/opportunities", "/tasks", "/catalog", "/notificacoes", "/agentsx", "/teams"])("%s é livre", (p) => {
    expect(isManagerOnlyPath(p)).toBe(false);
  });
});

describe("guardDecision", () => {
  it("vendedor em rota restrita é redirecionado para /inbox", () => {
    expect(guardDecision("/settings", "agent")).toEqual({ kind: "redirect", to: SELLER_HOME });
    expect(SELLER_HOME).toBe("/inbox");
  });
  it("enquanto o papel carrega, rota restrita espera (sem mostrar conteúdo)", () => {
    expect(guardDecision("/agents", null)).toEqual({ kind: "wait" });
  });
  it("gestor passa em tudo; rota livre passa mesmo sem papel", () => {
    expect(guardDecision("/costs", "owner")).toEqual({ kind: "allow" });
    expect(guardDecision("/team", "admin")).toEqual({ kind: "allow" });
    expect(guardDecision("/inbox", null)).toEqual({ kind: "allow" });
    expect(guardDecision("/notificacoes", "agent")).toEqual({ kind: "allow" });
  });
});

describe("menu por papel", () => {
  it("vendedor vê apenas Início, Conversas, Funil, Tarefas e Catálogo", () => {
    expect(visibleNavigation(false).map((i) => i.name)).toEqual(["Início", "Conversas", "Funil de vendas", "Tarefas", "Catálogo"]);
  });
  it("gestor vê tudo", () => {
    const names = visibleNavigation(true).map((i) => i.name);
    for (const n of ["Agentes", "Instancias", "Custos", "Equipe", "Configuracoes", "Ligações"]) expect(names).toContain(n);
  });
  it("todo item restrito do menu corresponde a uma rota restrita", () => {
    for (const item of visibleNavigation(true)) {
      const hidden = !visibleNavigation(false).some((i) => i.href === item.href);
      expect(isManagerOnlyPath(item.href)).toBe(hidden);
    }
  });
});

describe("menu do usuário", () => {
  it("oferece Notificações apontando para uma rota livre", () => {
    expect(USER_MENU_LINKS).toContainEqual({ label: "Notificações", href: NOTIFICATIONS_HREF });
    expect(isManagerOnlyPath(NOTIFICATIONS_HREF)).toBe(false);
  });
});
