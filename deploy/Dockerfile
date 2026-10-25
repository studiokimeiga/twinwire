# Staging template, not a validated production image. Native RTC build must pass its gate.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --ignore-scripts; else npm install --ignore-scripts; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# Native prebuilds may not exist for every target. These tools allow the dependency's source build.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ cmake \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Disable this project's prepare while installing runtime deps. Explicitly rebuild only the native dependency.
RUN npm install --omit=dev --ignore-scripts \
  && npm install --no-save --omit=dev --ignore-scripts node-datachannel@0.33.4 \
  && npm rebuild node-datachannel
COPY --from=build /app/dist ./dist
COPY examples ./examples
USER node
ENV HOST=0.0.0.0 PORT=8787 RTC=1 RTC_PORT=8788
EXPOSE 8787/tcp 8788/udp
CMD ["node", "examples/arena/server.mjs"]
