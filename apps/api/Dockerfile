FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/queue/package.json packages/queue/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/api/ apps/api/

# Build
RUN pnpm turbo build --filter=@aula-agente/api

WORKDIR /app/apps/api
RUN apk add --no-cache curl
EXPOSE 3001
CMD ["node", "dist/server.js"]
