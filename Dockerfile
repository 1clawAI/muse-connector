FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc && npm prune --production

FROM node:22-slim
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/dist dist
COPY package.json ./
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
