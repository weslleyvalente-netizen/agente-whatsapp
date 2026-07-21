import { StatusLamp } from "@/components/ui/status-lamp";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md px-4">
        <div className="mb-8 flex items-center justify-center gap-2">
          <StatusLamp tone="amber" pulse />
          <span className="label-eyebrow">aula-agente / console</span>
        </div>
        {children}
      </div>
    </div>
  );
}
