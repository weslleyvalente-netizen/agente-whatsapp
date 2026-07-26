"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Trash2, Plus } from "lucide-react";

interface ListEditorField<T> {
  key: keyof T;
  label: string;
  type: "text" | "textarea";
}

interface ListEditorProps<T extends { id: string; ativo: boolean }> {
  items: T[];
  fields: ListEditorField<T>[];
  titleKey: keyof T;
  emptyItem: () => T;
  onChange: (items: T[]) => void;
  addLabel: string;
}

export function ListEditor<T extends { id: string; ativo: boolean }>({
  items,
  fields,
  titleKey,
  emptyItem,
  onChange,
  addLabel,
}: ListEditorProps<T>) {
  const updateItem = (index: number, patch: Partial<T>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  const removeItem = (index: number) => onChange(items.filter((_, i) => i !== index));
  const addItem = () => onChange([...items, emptyItem()]);

  return (
    <div className="space-y-4">
      {items.map((item, index) => (
        <Card key={item.id}>
          <CardContent className="space-y-3 pt-6">
            <div className="flex items-center justify-between">
              <p className="font-medium">{String(item[titleKey]) || "(sem título)"}</p>
              <div className="flex items-center gap-2">
                <Switch checked={item.ativo} onCheckedChange={(v) => updateItem(index, { ativo: v } as Partial<T>)} />
                <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeItem(index)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
            {fields.map((field) => (
              <div key={String(field.key)} className="space-y-1">
                <Label>{field.label}</Label>
                {field.type === "textarea" ? (
                  <Textarea
                    value={String(item[field.key] ?? "")}
                    onChange={(e) => updateItem(index, { [field.key]: e.target.value } as Partial<T>)}
                  />
                ) : (
                  <Input
                    value={String(item[field.key] ?? "")}
                    onChange={(e) => updateItem(index, { [field.key]: e.target.value } as Partial<T>)}
                  />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
      <Button type="button" variant="outline" onClick={addItem}>
        <Plus className="mr-2 h-4 w-4" /> {addLabel}
      </Button>
    </div>
  );
}
