"use client";

import { useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ListEditor } from "./list-editor";
import type { AgentConfigDraft, AgentRules } from "@aula-agente/shared";

export type RegrasItemKey = "transferencia" | "promessas" | "regras_por_tipo" | "preco_desconto" | "objecoes";

interface RegrasSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { rules: AgentRules }) => Promise<void>;
  item: RegrasItemKey;
}

export function RegrasSection({ draft, onPatch, item }: RegrasSectionProps) {
  const [rules, setRules] = useState(draft.rules);

  const save = (next: AgentRules) => {
    setRules(next);
    onPatch({ rules: next });
  };

  if (item === "transferencia") {
    return (
      <Card>
        <CardHeader><CardTitle>Transferência para humano</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.transferencia_para_humano}
            titleKey="label"
            fields={[
              { key: "label", label: "Gatilho", type: "text" },
              { key: "instrucao", label: "O que a Helena deve fazer/dizer", type: "textarea" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), label: "", instrucao: "", ativo: true })}
            onChange={(items) => save({ ...rules, transferencia_para_humano: items })}
            addLabel="+ Novo gatilho"
          />
        </CardContent>
      </Card>
    );
  }

  if (item === "promessas") {
    return (
      <Card>
        <CardHeader><CardTitle>Promessas proibidas</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.promessas_proibidas}
            titleKey="label"
            fields={[
              { key: "label", label: "Título", type: "text" },
              { key: "instrucao", label: "Regra", type: "textarea" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), label: "", instrucao: "", ativo: true })}
            onChange={(items) => save({ ...rules, promessas_proibidas: items })}
            addLabel="+ Nova promessa proibida"
          />
        </CardContent>
      </Card>
    );
  }

  if (item === "regras_por_tipo") {
    return (
      <Card>
        <CardHeader><CardTitle>Regras por tipo de atendimento</CardTitle></CardHeader>
        <CardContent>
          <ListEditor
            items={rules.regras_por_tipo}
            titleKey="categoria"
            fields={[
              { key: "categoria", label: "Categoria", type: "text" },
              { key: "instrucao", label: "Instruções específicas", type: "textarea" },
            ]}
            emptyItem={() => ({ id: crypto.randomUUID(), categoria: "", instrucao: "", ativo: true })}
            onChange={(items) => save({ ...rules, regras_por_tipo: items })}
            addLabel="+ Nova categoria"
          />
          <p className="mt-2 text-sm text-muted-foreground">
            Sugestões de categoria: Consórcio, Financiamento, Moto 0 km, Moto seminova, Carro seminovo, Carta contemplada, Oficina, Peças, Outros.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (item === "preco_desconto") {
    return (
      <Card>
        <CardHeader><CardTitle>Preço e desconto</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Pode fazer autonomamente</Label>
            <Textarea
              value={rules.preco_desconto.pode_autonomo}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, pode_autonomo: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
          <div className="space-y-2">
            <Label>Exige humano</Label>
            <Textarea
              value={rules.preco_desconto.exige_humano}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, exige_humano: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
          <div className="space-y-2">
            <Label>Nunca pode fazer</Label>
            <Textarea
              value={rules.preco_desconto.nunca_pode}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, nunca_pode: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
          <div className="space-y-2">
            <Label>Observações</Label>
            <Textarea
              value={rules.preco_desconto.observacoes}
              onChange={(e) => setRules({ ...rules, preco_desconto: { ...rules.preco_desconto, observacoes: e.target.value } })}
              onBlur={() => save(rules)}
            />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Objeções</CardTitle></CardHeader>
      <CardContent>
        <ListEditor
          items={rules.objecoes}
          titleKey="nome"
          fields={[
            { key: "nome", label: "Nome (ex.: Preço alto)", type: "text" },
            { key: "como_identificar", label: "Como identificar", type: "textarea" },
            { key: "orientacao", label: "Orientação de resposta", type: "textarea" },
            { key: "pergunta_diagnostico", label: "Pergunta de diagnóstico", type: "text" },
            { key: "quando_escalar", label: "Quando transferir para humano", type: "text" },
          ]}
          emptyItem={() => ({
            id: crypto.randomUUID(), nome: "", como_identificar: "", orientacao: "",
            pergunta_diagnostico: "", quando_escalar: "", ativo: true,
          })}
          onChange={(items) => save({ ...rules, objecoes: items })}
          addLabel="+ Nova objeção"
        />
      </CardContent>
    </Card>
  );
}
