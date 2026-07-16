FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/queue/package.json packages/queue/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/ packages/
COPY apps/worker/ apps/worker/

# Build
RUN echo "bust=$(date +%s)" && pnpm turbo build --filter=@aula-agente/worker

WORKDIR /app/apps/worker
COPY apps/worker/healthcheck.js .
EXPOSE 3002
CMD ["node", "dist/index.js"]
