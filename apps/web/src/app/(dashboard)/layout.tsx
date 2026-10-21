import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OrganizationProvider } from "@/providers/organization-provider";
import { MobileNav } from "@/components/layout/mobile-nav";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { UserNav } from "@/components/layout/user-nav";
import { RouteGuard } from "@/components/layout/route-guard";
import { HealthBanner } from "@/components/layout/health-banner";
import { PushPromptBanner } from "@/components/layout/push-prompt-banner";
import { AvailabilitySelect } from "@/components/lead-distribution/availability-select";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <OrganizationProvider>
      <div className="flex h-dvh overflow-hidden md:h-screen">
        <AppSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-14 items-center justify-end gap-2 border-b px-3 max-md:h-[calc(3.5rem+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)] max-md:pl-[max(0.75rem,env(safe-area-inset-left))] max-md:pr-[max(0.75rem,env(safe-area-inset-right))] md:gap-4 md:px-6">
            <MobileNav />
            <div className="min-w-0 flex-1 md:hidden" />
            <AvailabilitySelect userId={user.id} />
            <UserNav email={user.email!} />
          </header>
          <HealthBanner />
          <PushPromptBanner />
          <main className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-6"><RouteGuard>{children}</RouteGuard></main>
        </div>
      </div>
    </OrganizationProvider>
  );
}
