import { FinancingAlerts } from '@/components/opportunities/financing-alerts';
import { PushNotificationsCard } from "@/components/settings/push-notifications-card";

/** Visível a todos os papéis (inclusive vendedor), que não têm acesso a Configurações. */
export default function NotificationsPage() {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Notificações</h1>
      <FinancingAlerts />
      <PushNotificationsCard />
    </div>
  );
}
