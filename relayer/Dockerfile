# Two-Tier Money Sandbox — relayer image
# Build stage compiles TypeScript; runtime ships dist + production deps only.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# deployments/<chain>.json is mounted read-only by docker-compose at /app/deployments
EXPOSE 3001
CMD ["node", "dist/index.js"]
