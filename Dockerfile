FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY api-server.js ./api-server.js
COPY lib ./lib
COPY public-world ./public-world
COPY scripts/create-admin.js ./scripts/create-admin.js
RUN mkdir -p /data/db && chown -R node:node /app /data

ENV NODE_ENV=production
ENV PORT=3000
ENV GS_DB_DIR=/data/db
ENV GS_DISABLED_MODULES=MEDICAL,FINANCE
ENV ANALYTICS_ENABLED=false
EXPOSE 3000
USER node
CMD ["npm", "start"]
