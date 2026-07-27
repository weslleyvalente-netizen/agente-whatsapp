"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagInput } from "./tag-input";
import type { AgentConfigDraft, AgentPersonality } from "@aula-agente/shared";

export type PersonalidadeItemKey =
  | "tom_de_voz"
  | "emojis"
  | "perguntas_por_vez"
  | "postura_comercial"
  | "girias"
  | "proatividade";

const TOM_LABELS: Record<AgentPersonality["tom_de_voz"], string> = {
  profissional: "Profissional", equilibrado: "Equilibrado", amigavel: "Amigável",
  divertido: "Divertido", personalizado: "Personalizado",
};
const TAMANHO_LABELS: Record<AgentPersonality["tamanho_resposta"], string> = {
  curta: "Curta", media: "Média", detalhada: "Detalhada",
};

interface PersonalidadeSectionProps {
  draft: AgentConfigDraft;
  onPatch: (patch: { personality: AgentPersonality }) => Promise<void>;
  item: PersonalidadeItemKey;
}

export function PersonalidadeSection({ draft, onPatch, item }: PersonalidadeSectionProps) {
  const [personality, setPersonality] = useState(draft.personality);

  const save = (next: AgentPersonality) => {
    setPersonality(next);
    onPatch({ personality: next });
  };

  if (item === "tom_de_voz") {
    return (
      <Card>
        <CardHeader><CardTitle>Tom de voz e tamanho das respostas</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tom de voz</Label>
              <Select value={personality.tom_de_voz} onValueChange={(v) => v && save({ ...personality, tom_de_voz: v as AgentPersonality["tom_de_voz"] })}>
                <SelectTrigger><SelectValue>{(value: string) => TOM_LABELS[value as AgentPersonality["tom_de_voz"]]}</SelectValue></SelectTrigger>
                <SelectContent>
                  {Object.entries(TOM_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Tamanho das respostas</Label>
              <Select value={personality.tamanho_resposta} onValueChange={(v) => v && save({ ...personality, tamanho_resposta: v as AgentPersonality["tamanho_resposta"] })}>
                <SelectTrigger><SelectValue>{(value: string) => TAMANHO_LABELS[value as AgentPersonality["tamanho_resposta"]]}</SelectValue></SelectTrigger>
                <SelectContent>
                  {Object.entries(TAMANHO_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {personality.tom_de_voz === "personalizado" && (
            <div className="space-y-2">
              <Label>Descreva o tom personalizado</Label>
              <Textarea
                value={personality.tom_de_voz_personalizado}
                onChange={(e) => setPersonality({ ...personality, tom_de_voz_personalizado: e.target.value })}
                onBlur={() => save(personality)}
              />
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  if (item === "emojis") {
    return (
      <Card>
        <CardHeader><CardTitle>Emojis</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Ativo</Label>
            <Switch checked={personality.emojis.ativo} onCheckedChange={(v) => save({ ...personality, emojis: { ...personality.emojis, ativo: v } })} />
          </div>
          <div className="space-y-2">
            <Label>Máximo por mensagem</Label>
            <Input
              type="number" min={0} max={5}
              value={personality.emojis.maximo}
              onChange={(e) => setPersonality({ ...personality, emojis: { ...personality.emojis, maximo: Number(e.target.value) } })}
              onBlur={() => save(personality)}
            />
          </div>
          <div className="space-y-2">
            <Label>Instrução adicional</Label>
            <Input
              value={personality.emojis.instrucao}
              placeholder="Ex.: no máximo um emoji quando realmente fizer sentido"
              onChange={(e) => setPersonality({ ...personality, emojis: { ...personality.emojis, instrucao: e.target.value } })}
              onBlur={() => save(personality)}
            />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (item === "perguntas_por_vez") {
    return (
      <Card>
        <CardHeader><CardTitle>Perguntas por vez</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label>Máximo de perguntas por mensagem</Label>
            <Input
              type="number" min={1} max={5}
              value={personality.perguntas_por_vez.maximo}
              onChange={(e) => setPersonality({ ...personality, perguntas_por_vez: { maximo: Number(e.target.value) } })}
              onBlur={() => save(personality)}
            />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (item === "postura_comercial") {
    return (
      <Card>
        <CardHeader><CardTitle>Postura comercial</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Tipo</Label>
            <Input
              value={personality.postura_comercial.tipo}
              placeholder="Ex.: Consultiva / qualificadora"
              onChange={(e) => setPersonality({ ...personality, postura_comercial: { ...personality.postura_comercial, tipo: e.target.value } })}
              onBlur={() => save(personality)}
            />
          </div>
          <div className="space-y-2">
            <Label>Instrução</Label>
            <Textarea
              value={personality.postura_comercial.instrucao}
              placeholder="Ajudar o cliente a decidir; não pressionar; não forçar venda; entender antes de oferecer."
              onChange={(e) => setPersonality({ ...personality, postura_comercial: { ...personality.postura_comercial, instrucao: e.target.value } })}
              onBlur={() => save(personality)}
            />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (item === "girias") {
    return (
      <Card>
        <CardHeader><CardTitle>Gírias e expressões proibidas</CardTitle></CardHeader>
        <CardContent>
          <TagInput
            tags={personality.girias_proibidas}
            onChange={(tags) => save({ ...personality, girias_proibidas: tags })}
            placeholder="Digite uma expressão e pressione Enter"
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader><CardTitle>Proatividade</CardTitle></CardHeader>
      <CardContent>
        <Textarea
          rows={6}
          value={personality.proatividade}
          onChange={(e) => setPersonality({ ...personality, proatividade: e.target.value })}
          onBlur={() => save(personality)}
        />
      </CardContent>
    </Card>
  );
}
