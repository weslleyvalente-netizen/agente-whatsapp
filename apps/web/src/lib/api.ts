import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Routes that fail zod validation respond with `error` as an array of zod
// issues (path + message), not a string — `new Error(anArray)` stringifies
// it as "[object Object]", so turn it into readable text first.
function formatApiError(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (Array.isArray(error)) {
    return error
      .map((issue) => {
        if (issue && typeof issue === "object" && "message" in issue) {
          const path = Array.isArray((issue as { path?: unknown[] }).path) ? (issue as { path: unknown[] }).path : [];
          const message = String((issue as { message: unknown }).message);
          return path.length > 0 ? `${path.join(".")}: ${message}` : message;
        }
        return String(issue);
      })
      .join("; ");
  }
  return undefined;
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(formatApiError(body.error) || `API error: ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}
