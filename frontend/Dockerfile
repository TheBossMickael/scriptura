# Built from the repo ROOT context (see docker-compose `front.build.context: .`) because the
# app imports deployments/<chain>.json at build time, which lives outside frontend/.
FROM node:20-alpine AS build
WORKDIR /repo

COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci

COPY frontend/ frontend/
COPY deployments/ deployments/

ARG VITE_RELAYER_URL
ARG VITE_PONDER_URL
# Vite reads VITE_* from .env in envDir (repo root) — materialize them for the build.
RUN printf "VITE_RELAYER_URL=%s\nVITE_PONDER_URL=%s\n" "$VITE_RELAYER_URL" "$VITE_PONDER_URL" > /repo/.env
RUN cd frontend && npm run build

FROM nginx:alpine
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
