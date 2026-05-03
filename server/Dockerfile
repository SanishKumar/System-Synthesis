FROM node:20-alpine AS builder

WORKDIR /app

# Copy the root workspace config and lockfile
COPY package.json package-lock.json ./

# Copy the specific workspace packages we need
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Install all dependencies (resolves workspace symlinks)
RUN npm ci

# Copy the actual source code for shared and server
COPY shared/ ./shared/
COPY server/ ./server/

# Build the shared and server packages
RUN npm run build --workspace=server

# --- Production Image ---
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Copy root config and specific packages again
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY shared/package.json ./shared/

# Install only production dependencies
RUN npm ci --omit=dev

# Copy the built artifacts and shared files
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server/dist ./server/dist

EXPOSE 4000

# Start the server workspace
CMD ["npm", "start", "--workspace=server"]
