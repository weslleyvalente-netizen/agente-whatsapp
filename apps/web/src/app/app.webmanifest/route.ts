// Manifesto do app instalável. Endereço e ícones novos (sem ?v=): o Safari do iPhone guarda por URL o resultado da busca
// e seguia mostrando a letra M no "Adicionar à Tela de Início" mesmo com os ícones já corretos.
import { APP_ICON_DATA_URI } from "@/lib/app-icon";

const base = {
  name: "Moto e Trilha — Atendimento",
  short_name: "Moto e Trilha",
  description: "Atendimento e vendas da Moto e Trilha Veículos",
  start_url: "/inbox",
  scope: "/",
  display: "standalone",
  orientation: "portrait",
  lang: "pt-BR",
  background_color: "#ffffff",
  theme_color: "#f6f8fb",
};

// Android/Chrome: ícones por endereço.
const iconsByUrl = [
  { src: "/icons/app-icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
  { src: "/icons/app-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
  { src: "/icons/app-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  { src: "/icons/app-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
];

// iPhone: o Safari não conseguia baixar o ícone por endereço no "Adicionar à Tela de Início" (letra M).
// Só um ícone, embutido (data URI): foi a combinação que funcionou nos testes no aparelho.
const iconsForIos = [{ src: APP_ICON_DATA_URI, sizes: "180x180", type: "image/png", purpose: "any" }];

export function GET(request: Request) {
  const ua = request.headers.get("user-agent") ?? "";
  const ios = /iPhone|iPad|iPod/i.test(ua);
  return new Response(JSON.stringify({ ...base, icons: ios ? iconsForIos : iconsByUrl }), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache",
      Vary: "User-Agent",
    },
  });
}
