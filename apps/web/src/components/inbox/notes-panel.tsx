"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import type { ConversationNote } from "@aula-agente/shared";

interface NotesPanelProps {
  conversationId: string;
  organizationId: string;
}

export function NotesPanel({ conversationId, organizationId }: NotesPanelProps) {
  const [notes, setNotes] = useState<ConversationNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchNotes = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("conversation_notes")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false });
    setNotes((data as ConversationNote[]) || []);
  }, [conversationId]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  const handleAdd = async () => {
    if (!newNote.trim()) return;
    setSaving(true);

    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();

    await supabase.from("conversation_notes").insert({
      conversation_id: conversationId,
      organization_id: organizationId,
      user_id: user!.id,
      content: newNote.trim(),
    });

    setNewNote("");
    setSaving(false);
    fetchNotes();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Textarea
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Nota interna..."
          rows={2}
          className="text-xs"
        />
        <Button size="icon" onClick={handleAdd} disabled={saving || !newNote.trim()}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-2">
        {notes.map((note) => (
          <div key={note.id} className="rounded-md border border-primary/20 bg-primary/10 p-2 text-xs">
            <p>{note.content}</p>
            <p className="mt-1 text-muted-foreground">
              {new Date(note.created_at).toLocaleString("pt-BR")}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
