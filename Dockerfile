# QR ID — small self-hosted Node app (uses Node's built-in SQLite, no build step)
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# Everything the app writes (database, photos, logo, secret key) lives here.
VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
