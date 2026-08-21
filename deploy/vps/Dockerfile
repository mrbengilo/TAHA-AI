FROM node:22-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
ENV NODE_ENV=production
ENV WRANGLER_SEND_METRICS=false

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

RUN chmod 0755 /app/deploy/vps/start.sh

EXPOSE 8787

ENTRYPOINT ["/app/deploy/vps/start.sh"]
