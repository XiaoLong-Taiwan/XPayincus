FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /opt/incudal/app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY client/package.json ./client/package.json
COPY server/package.json ./server/package.json
COPY server/prisma ./server/prisma
COPY server/prisma.config.ts ./server/prisma.config.ts
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
RUN pnpm install --frozen-lockfile
COPY client ./client
COPY server ./server
ARG VITE_CUSTOMER_BASE_URL
ARG VITE_ADMIN_BASE_URL
ENV VITE_API_BASE_URL=/api
ENV VITE_CUSTOMER_BASE_URL=${VITE_CUSTOMER_BASE_URL}
ENV VITE_ADMIN_BASE_URL=${VITE_ADMIN_BASE_URL}
RUN pnpm --filter client build && pnpm --filter server build
RUN test -s client/dist/user/index.html && test -s client/dist/admin/index.html && test -s server/dist/app.js \
    && test -s server/templates/install.sh && test -s server/templates/agent-install.sh && test -s server/templates/caddy.sh

FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates gosu && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.14.2 --activate
WORKDIR /opt/incudal/app
COPY --from=build /opt/incudal/app/package.json /opt/incudal/app/pnpm-lock.yaml /opt/incudal/app/pnpm-workspace.yaml ./
COPY --from=build /opt/incudal/app/node_modules ./node_modules
COPY --from=build /opt/incudal/app/server ./server
COPY deploy/compose/api-entrypoint.sh /usr/local/bin/panel-api
RUN install -d -m 700 -o node -g node /opt/incudal/server/certs /opt/incudal/config /opt/incudal/backups
WORKDIR /opt/incudal/app/server
ENTRYPOINT ["sh", "/usr/local/bin/panel-api"]

FROM nginx:1.28-alpine AS web
COPY --from=build /opt/incudal/app/client/dist /usr/share/nginx/panel
COPY deploy/compose/nginx.conf.template /etc/nginx/templates/default.conf.template
ENV NGINX_ENVSUBST_FILTER=^PANEL_ENTRY$
