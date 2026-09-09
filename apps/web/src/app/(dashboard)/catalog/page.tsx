export default function CatalogPage() {
  return (
    <div className="flex h-full flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">Catálogo</h1>
        <p className="text-sm text-muted-foreground">Gerencie os produtos à venda.</p>
      </div>
      <iframe
        src="https://catalogo.motoetrilha.com.br/admin"
        title="Catálogo Moto e Trilha"
        className="flex-1 w-full rounded-md border"
      />
    </div>
  );
}
