// Manifesto do app instalável. Endereço e ícones novos (sem ?v=): o Safari do iPhone guarda por URL o resultado da busca
// e seguia mostrando a letra M no "Adicionar à Tela de Início" mesmo com os ícones já corretos.
const manifest = {
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
  icons: [
    { src: "/icons/app-icon-180.png", sizes: "180x180", type: "image/png", purpose: "any" },
    { src: "/icons/app-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/app-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/app-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};

export function GET() {
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
