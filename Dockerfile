
# ==========================================
# STAGE 1: Build React frontend
# ==========================================
FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend

# Supabase frontend configuration
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}

COPY frontend/package*.json ./

RUN npm install

COPY frontend/ ./

RUN npm run build


# ==========================================
# STAGE 2: Build Node.js backend
# ==========================================
FROM node:22-alpine AS backend-build

WORKDIR /app/backend

COPY backend/package*.json ./

RUN npm install

COPY backend/ ./

RUN npm run build


# ==========================================
# STAGE 3: Production application
# ==========================================
FROM node:22-alpine AS production

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=10000

# Backend package configuration
COPY backend/package*.json ./

# Install production dependencies
RUN npm install --omit=dev

# Copy compiled backend
COPY --from=backend-build /app/backend/dist ./dist

# Copy frontend production files
COPY --from=frontend-build /app/frontend/dist ./public

EXPOSE 10000

CMD ["npm", "start"]
