import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OrganizationProvider } from "@/providers/organization-provider";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { UserNav } from "@/components/layout/user-nav";
import { AvailabilitySelect } from "@/components/lead-distribution/availability-select";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <OrganizationProvider>
      <div className="flex h-screen overflow-hidden">
        <AppSidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-14 items-center justify-end gap-4 border-b px-6">
            <AvailabilitySelect userId={user.id} />
            <UserNav email={user.email!} />
          </header>
          <main className="flex-1 overflow-y-auto overflow-x-hidden p-6">{children}</main>
        </div>
      </div>
    </OrganizationProvider>
  );
}
