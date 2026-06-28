FROM node:20-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Ponder's HTTP API (custom REST + the indexer).
EXPOSE 42069

# Production mode: index from startBlock then serve. Reads addresses from the mounted
# deployments volume (DEPLOYMENTS_DIR) and the RPC from PONDER_RPC_URL.
CMD ["npm", "start"]
