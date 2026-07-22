import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OrganizationProvider } from "@/providers/organization-provider";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { UserNav } from "@/components/layout/user-nav";

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
          <header className="flex h-14 items-center justify-end border-b px-6">
            <UserNav email={user.email!} />
          </header>
          <main className="flex-1 overflow-y-auto overflow-x-hidden p-6">{children}</main>
        </div>
      </div>
    </OrganizationProvider>
  );
}
