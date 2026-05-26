FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src ./src

# Set environment
ENV NODE_ENV=production
ENV PORT=8000

# Expose port (for documentation, Railway uses PORT env var)
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8000/mcp', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Start the HTTP server
CMD ["npm", "start"]
