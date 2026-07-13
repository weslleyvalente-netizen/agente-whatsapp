"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

interface TagsInputProps {
  conversationId: string;
  tags: string[];
  onUpdate: () => void;
}

export function TagsInput({ conversationId, tags, onUpdate }: TagsInputProps) {
  const [input, setInput] = useState("");

  const handleAdd = async () => {
    if (!input.trim() || tags.includes(input.trim())) return;
    const newTags = [...tags, input.trim()];
    const supabase = createClient();
    await supabase.from("conversations").update({ tags: newTags }).eq("id", conversationId);
    setInput("");
    onUpdate();
  };

  const handleRemove = async (tag: string) => {
    const newTags = tags.filter((t) => t !== tag);
    const supabase = createClient();
    await supabase.from("conversations").update({ tags: newTags }).eq("id", conversationId);
    onUpdate();
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tag}
            <button onClick={() => handleRemove(tag)}>
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
      <Input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        placeholder="Adicionar tag..."
        className="h-8 text-xs"
      />
    </div>
  );
}
