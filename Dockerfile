# Node 26 is not a preference here: the hub runs TypeScript with no build step
# and uses node:sqlite from core. Older majors have neither.
FROM node:26-alpine

WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json package-lock.json ./
COPY packages/web/package.json packages/web/
COPY packages/hub/package.json packages/hub/
COPY packages/client/package.json packages/client/
COPY packages/protocol/package.json packages/protocol/
RUN npm ci

COPY packages/ packages/

# The web bundle is built at image build time: the hub serves it as static files.
RUN npm run web

# State lives on a volume — a container rebuild must not wipe the claims.
ENV VIBEGRAM_DB=/data/vibegram.db
ENV VIBEGRAM_PORT=4321
VOLUME /data

EXPOSE 4321
CMD ["node", "packages/hub/src/index.ts"]
