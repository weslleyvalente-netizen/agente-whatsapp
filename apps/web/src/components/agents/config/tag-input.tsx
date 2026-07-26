"use client";

import { useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

interface TagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}

export function TagInput({ tags, onChange, placeholder }: TagInputProps) {
  const [draft, setDraft] = useState("");

  const commitDraft = () => {
    const value = draft.trim();
    if (value && !tags.includes(value)) onChange([...tags, value]);
    setDraft("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitDraft();
    }
  };

  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1">
              {tag}
              <button type="button" onClick={() => onChange(tags.filter((t) => t !== tag))} aria-label={`Remover ${tag}`}>
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={handleKeyDown} onBlur={commitDraft} placeholder={placeholder} />
    </div>
  );
}
