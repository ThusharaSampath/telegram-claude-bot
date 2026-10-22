FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV HOME=/tmp \
    PORT=8080 \
    NODE_ENV=production \
    PATH=/app/node_modules/.bin:$PATH

EXPOSE 8080
CMD ["node", "server.mjs"]
