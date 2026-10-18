import { Home, Inbox, Kanban, Bot, Radio, Users, Settings, DollarSign, ListChecks, Phone, ShoppingBag } from "lucide-react";

export interface NavItem { name: string; href: string; icon: typeof Home; managerOnly?: boolean }

export const navigation: NavItem[] = [
  { name: "Início", href: "/", icon: Home },
  { name: "Conversas", href: "/inbox", icon: Inbox },
  { name: "Funil de vendas", href: "/opportunities", icon: Kanban },
  { name: "Tarefas", href: "/tasks", icon: ListChecks },
  { name: "Ligações", href: "/calls", icon: Phone, managerOnly: true },
  { name: "Catálogo", href: "/catalog", icon: ShoppingBag },
  { name: "Agentes", href: "/agents", icon: Bot, managerOnly: true },
  { name: "Instancias", href: "/instances", icon: Radio, managerOnly: true },
  { name: "Custos", href: "/costs", icon: DollarSign, managerOnly: true },
  { name: "Equipe", href: "/team", icon: Users, managerOnly: true },
  { name: "Configuracoes", href: "/settings", icon: Settings, managerOnly: true },
];

export const visibleNavigation = (isManager: boolean): NavItem[] => navigation.filter((i) => !i.managerOnly || isManager);
