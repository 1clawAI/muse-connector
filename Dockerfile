# Base images are pinned by digest, not by tag.
#
# `node:22-slim` and friends are moving tags: the same line can resolve to
# different userland in two builds a week apart, which makes a build
# unreproducible and means an upstream compromise arrives without any change
# here. The tag is kept beside the digest for readability; the digest is what
# docker actually resolves.
#
# renovate.json keeps these current -- a pin nobody updates is its own problem,
# because it freezes known-bad versions in place.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc && npm prune --production

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=builder /app/node_modules node_modules
COPY --from=builder /app/dist dist
COPY package.json ./
USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
