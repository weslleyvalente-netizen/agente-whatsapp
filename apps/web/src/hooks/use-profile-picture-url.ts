"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import { createProfilePictureResolver } from "@/lib/profile-pictures";

const profilePictureResolver = createProfilePictureResolver(async (ids) => {
  const res = (await apiFetch("/contacts/profile-picture-urls", {
    method: "POST",
    body: JSON.stringify({ contact_ids: ids }),
  })) as { urls?: Record<string, string> } | null;
  return res?.urls ?? {};
});

/** Link assinado da foto do contato; null enquanto carrega, sem foto ou em erro. */
export function useProfilePictureUrl(contactId: string | undefined, picturePath: string | null): string | null {
  const [state, setState] = useState<{ key: string; url: string | null } | null>(null);
  const key = contactId && picturePath ? `${contactId}|${picturePath}` : null;

  useEffect(() => {
    if (!key || !contactId) return;
    let cancelled = false;
    profilePictureResolver.request(contactId).then((url) => {
      if (!cancelled) setState({ key, url });
    });
    return () => {
      cancelled = true;
    };
  }, [key, contactId]);

  return key && state?.key === key ? state.url : null;
}
