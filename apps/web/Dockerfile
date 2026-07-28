FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/shared/ packages/shared/
COPY packages/database/ packages/database/
COPY apps/web/ apps/web/

# NEXT_PUBLIC_* values are inlined into the client bundle at build time by
# `next build` — unlike apps/api and apps/worker, setting these as runtime
# container env vars alone is not enough, they must be present here as
# build args. All three are meant to be public (the Supabase anon key is
# designed to be exposed to the browser, protected by RLS instead of
# secrecy), so baking them into the image is expected, not a leak.
ARG NEXT_PUBLIC_API_URL=https://agente-whatsapp-api.qinw5t.easypanel.host
ARG NEXT_PUBLIC_SUPABASE_URL=https://fwwulkmriqkrzozcsqnx.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3d3Vsa21yaXFrcnpvemNzcW54Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI5NDM0ODQsImV4cCI6MjA5ODUxOTQ4NH0.oX0T93oUS1UTlKEtaoIptcxW7XW5OVbKvrMeA3dLRKk
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

# Build
RUN echo "bust=$(date +%s)" && pnpm turbo build --filter=@aula-agente/web

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
