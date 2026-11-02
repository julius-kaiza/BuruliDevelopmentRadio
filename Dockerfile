
FROM node:22-alpine

WORKDIR /app/backend

# Copy package configuration
COPY backend/package*.json ./

# Install all dependencies, including TypeScript
RUN npm install

# Copy backend source code
COPY backend/ ./

# Compile TypeScript into dist/
RUN npm run build

# Remove development dependencies
RUN npm prune --omit=dev

# Production configuration
ENV NODE_ENV=production

# Render supplies its own PORT
EXPOSE 10000

# Start the application
CMD ["npm", "start"]
