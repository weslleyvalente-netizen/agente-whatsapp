export const NOTIFICATIONS_HREF = "/notificacoes";

/** Links do menu da conta, visíveis a todos os papéis. */
export const USER_MENU_LINKS = [{ label: "Notificações", href: NOTIFICATIONS_HREF }] as const satisfies readonly { label: string; href: string }[];
