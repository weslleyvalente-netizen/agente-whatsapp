"use client";

import { avatarColorIndex, contactInitials } from "@aula-agente/shared";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useProfilePictureUrl } from "@/hooks/use-profile-picture-url";
import { cn } from "@/lib/utils";

const PALETTE = [
  "bg-rose-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-emerald-600",
  "bg-teal-600",
  "bg-sky-600",
  "bg-indigo-500",
  "bg-violet-500",
  "bg-fuchsia-500",
  "bg-slate-500",
] as const;

interface ContactAvatarProps {
  contactId: string;
  name: string | null;
  phone: string;
  picturePath: string | null | undefined;
  className?: string;
}

export function ContactAvatar({ contactId, name, phone, picturePath, className }: ContactAvatarProps) {
  const url = useProfilePictureUrl(contactId, picturePath ?? null);
  const color = PALETTE[avatarColorIndex(contactId, PALETTE.length)];
  return (
    <Avatar className={cn("h-10 w-10", className)}>
      {url && <AvatarImage src={url} alt="" referrerPolicy="no-referrer" />}
      <AvatarFallback className={cn("font-medium text-white", color)}>{contactInitials(name, phone)}</AvatarFallback>
    </Avatar>
  );
}
