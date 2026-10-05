FROM node:24-alpine

WORKDIR /app

# Copy the root workspace config and lockfile
COPY package.json package-lock.json ./

# Copy all manifests for deterministic workspace resolution.
COPY server/package.json ./server/
COPY architecture-core/package.json ./architecture-core/
COPY architecture-cli/package.json ./architecture-cli/
COPY architecture-action/package.json ./architecture-action/
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

# Install only the frontend development workspaces, without lifecycle scripts.
RUN npm ci --ignore-scripts --workspace=frontend --workspace=shared

# Copy source
COPY shared/ ./shared/
COPY frontend/ ./frontend/

EXPOSE 3000

CMD ["npm", "run", "dev", "--workspace=frontend"]
