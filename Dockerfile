# DNS Web Proxy Docker Image
FROM node:18-alpine

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application source
COPY src/ ./src/
COPY public/ ./public/
COPY scripts/ ./scripts/

# Create directories for persistent data
RUN mkdir -p /app/certs /app/logs

# Set proper permissions
RUN chown -R node:node /app

# Switch to non-root user
USER node

# Expose ports
# DNS (UDP + TCP), HTTP, HTTPS, Dashboard
EXPOSE 53/udp 53/tcp 80 443 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1))" || exit 1

# Use dumb-init as PID 1 for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/index.js"]
