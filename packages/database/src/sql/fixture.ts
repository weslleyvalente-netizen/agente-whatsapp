// packages/database/src/sql/fixture.ts
// Esquema mínimo das tabelas existentes que as funções novas leem/escrevem. Só para testes.
export const FIXTURE_SQL = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), settings jsonb NOT NULL DEFAULT '{}');
CREATE TABLE public.organization_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), user_id uuid NOT NULL, role text NOT NULL DEFAULT 'agent');
CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id));
CREATE TABLE public.conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), assigned_to uuid, is_human_takeover boolean NOT NULL DEFAULT false);
CREATE TABLE public.opportunities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), status text NOT NULL DEFAULT 'open', stage text NOT NULL DEFAULT 'interest_received', owner_id uuid, operation text, product_model text);
CREATE TABLE public.tasks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), contact_id uuid NOT NULL REFERENCES public.wa_contacts(id), status text NOT NULL DEFAULT 'pending', assignee_type text, assignee_id uuid);
CREATE TABLE public.handoff_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id), trigger_type text NOT NULL DEFAULT 'request_human', handed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id), conversation_id uuid NOT NULL REFERENCES public.conversations(id), role text NOT NULL, content text, evolution_message_id text, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.get_user_org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid WHERE false $$;
`;
