FROM node:20-alpine AS builder

WORKDIR /app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install dependencies (including devDependencies for building)
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the TypeScript code
RUN npm run build

# --- Production Image ---
FROM node:20-alpine

WORKDIR /app

# Set node environment to production
ENV NODE_ENV=production

# Copy package files and install only production dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy the built artifacts from the builder stage
COPY --from=builder /app/dist ./dist

# Expose the port the app runs on
EXPOSE 4000

# Start the application
CMD ["npm", "start"]
