# Multi-stage Dockerfile for GitOrch Control Plane
# Stage 1: Builder
FROM node:20-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json ./apps/control-plane/
COPY packages/*/package.json ./packages/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma client
RUN cd apps/control-plane && npx prisma generate

# Build the application
RUN cd apps/control-plane && npm run build

# Stage 2: Production
FROM node:20-alpine AS production

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Create non-root user
RUN addgroup -g 1000 -S nodejs && adduser -S nodejs -u 1000 -G nodejs

# Copy package files and install production deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/control-plane/package.json ./apps/control-plane/
COPY packages/*/package.json ./packages/

RUN pnpm install --prod --frozen-lockfile

# Copy built application and Prisma client
COPY --from=builder /app/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=builder /app/apps/control-plane/prisma ./apps/control-plane/prisma
COPY --from=builder /app/apps/control-plane/node_modules/.prisma ./apps/control-plane/node_modules/.prisma

# Change ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "apps/control-plane/dist/index.js"]