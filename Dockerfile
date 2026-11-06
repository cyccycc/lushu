FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/llm/package.json packages/llm/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY evals/package.json evals/package.json
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 3847
CMD ["pnpm", "start"]
