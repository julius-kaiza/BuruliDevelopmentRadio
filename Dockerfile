
# ==========================================
# STAGE 1: BUILD REACT FRONTEND
# ==========================================
FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend

# Frontend environment variables supplied by Render
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_BASE_URL
ARG VITE_WHATSAPP_GROUP_URL

# Make variables available during Vite compilation
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_WHATSAPP_GROUP_URL=${VITE_WHATSAPP_GROUP_URL}

# Install frontend dependencies
COPY frontend/package*.json ./
RUN npm install

# Copy and build frontend
COPY frontend/ ./
RUN npm run build


# ==========================================
# STAGE 2: BUILD NODE.JS BACKEND
# ==========================================
FROM node:22-alpine AS backend-build

WORKDIR /app/backend

# Install backend dependencies
COPY backend/package*.json ./
RUN npm install

# Copy backend source
COPY backend/ ./

# Compile TypeScript
RUN npm run build


# ==========================================
# STAGE 3: PRODUCTION APPLICATION
# ==========================================
FROM node:22-alpine AS production

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=10000

# Backend package configuration
COPY backend/package*.json ./

# Install production dependencies only
RUN npm install --omit=dev

# Copy compiled backend
COPY --from=backend-build /app/backend/dist ./dist

# Copy compiled frontend into backend public directory
COPY --from=frontend-build /app/frontend/dist ./public

# Application port
EXPOSE 10000

# Start production server
CMD ["npm", "start"]
