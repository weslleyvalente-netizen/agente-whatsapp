import type { FastifyRequest, FastifyReply } from "fastify";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY!;

export async function authMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Missing or invalid authorization header" });
  }

  const token = authHeader.slice(7);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: { user }, error } = await supabase.auth.getUser();

  if (error || !user) {
    return reply.status(401).send({ error: "Invalid or expired token" });
  }

  // Fetch user's organizations
  const { data: memberships, error: memberError } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", user.id);

  if (memberError) {
    return reply.status(500).send({ error: "Failed to fetch user memberships" });
  }

  request.user = {
    id: user.id,
    email: user.email!,
    memberships: memberships || [],
  };
}

// Middleware to require specific org access
export function requireOrg(request: FastifyRequest, reply: FastifyReply) {
  const orgId = (request.params as Record<string, string>).organizationId
    || (request.body as Record<string, string>)?.organization_id
    || request.headers["x-organization-id"] as string;

  if (!orgId) {
    return reply.status(400).send({ error: "Missing organization ID" });
  }

  const membership = request.user.memberships.find(
    (m: { organization_id: string }) => m.organization_id === orgId
  );

  if (!membership) {
    return reply.status(403).send({ error: "Not a member of this organization" });
  }

  request.organizationId = orgId;
  request.userRole = membership.role;
}

// Augment Fastify types
declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      email: string;
      memberships: Array<{ organization_id: string; role: string }>;
    };
    organizationId: string;
    userRole: string;
  }
}
