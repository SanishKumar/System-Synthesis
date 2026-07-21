FROM node:20-alpine AS builder

WORKDIR /app

# Copy the root workspace config and lockfile
COPY package.json package-lock.json ./

# Copy workspace manifests so npm can resolve the lockfile's workspace links.
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY architecture-core/package.json ./architecture-core/
COPY architecture-cli/package.json ./architecture-cli/
COPY architecture-action/package.json ./architecture-action/
COPY frontend/package.json ./frontend/

# Install only the workspaces needed to compile the backend.
RUN npm ci --ignore-scripts \
    --workspace=server \
    --workspace=architecture-core \
    --workspace=shared

# Copy the source required by the backend runtime.
COPY shared/ ./shared/
COPY architecture-core/ ./architecture-core/
COPY server/ ./server/

# Build the extracted analysis engine before the server that imports it.
RUN npm run build --workspace=architecture-core \
    && npm run build --workspace=server

# --- Production Image ---
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copy all workspace manifests for deterministic lockfile installation.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/
COPY architecture-core/package.json ./architecture-core/
COPY architecture-cli/package.json ./architecture-cli/
COPY architecture-action/package.json ./architecture-action/
COPY frontend/package.json ./frontend/

# Install only backend production dependencies and skip lifecycle scripts.
RUN npm ci --omit=dev --ignore-scripts \
    --workspace=server \
    --workspace=architecture-core \
    --workspace=shared

# Copy the built artifacts and shared type package.
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/architecture-core/dist ./architecture-core/dist
COPY --from=builder /app/server/dist ./server/dist

EXPOSE 4000

# Start the server workspace
CMD ["npm", "start", "--workspace=server"]
