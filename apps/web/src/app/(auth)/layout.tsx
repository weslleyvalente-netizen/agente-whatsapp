import { StatusLamp } from "@/components/ui/status-lamp";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md px-4">
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="rounded-lg bg-white px-6 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo-moto-e-trilha.png" alt="Moto e Trilha Veículos" className="h-28 w-auto" />
          </div>
          <div className="flex items-center gap-2">
            <StatusLamp tone="green" pulse />
            <span className="label-eyebrow">Moto e Trilha / atendimento</span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}
