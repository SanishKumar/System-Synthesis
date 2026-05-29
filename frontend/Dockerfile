FROM node:20-alpine

WORKDIR /app

# Copy the root workspace config and lockfile
COPY package.json package-lock.json ./

# Copy workspace packages
COPY frontend/package.json ./frontend/
COPY shared/package.json ./shared/

# Install dependencies
RUN npm ci

# Copy source
COPY shared/ ./shared/
COPY frontend/ ./frontend/

EXPOSE 3000

CMD ["npm", "run", "dev", "--workspace=frontend"]
