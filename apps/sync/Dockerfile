# syntax=docker/dockerfile:1
#
# The sync service image. Two properties drive every choice here:
#   1. apps/sync has ZERO npm dependencies, so the runtime stage carries no node_modules at all -
#      just emitted JavaScript, the git binary, and litestream.
#   2. It serves git smart-HTTP by spawning the real `git http-backend`, so `git` is a hard runtime
#      requirement, not a build-time one.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT:
#   docker build -f apps/sync/Dockerfile -t buildex-sync .

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app

# Install the compiler directly rather than running a workspace `npm ci`: the root install would
# pull Electron for apps/client, which this image will never run. Versions track the root manifest.
RUN npm install -g typescript@5.7 @types/node@22

COPY apps/sync/tsconfig.json apps/sync/tsconfig.build.json apps/sync/package.json ./apps/sync/
COPY tsconfig.base.json ./
COPY apps/sync/src ./apps/sync/src

WORKDIR /app/apps/sync
# The global @types/node install above lands under npm's global node_modules, which tsc's default
# typeRoots resolution never walks into (it only looks at ./node_modules/@types up the tree from
# the project). Symlink it into the project so `node:*` / process / Buffer types resolve without
# touching the checked-in tsconfig files.
RUN mkdir -p node_modules \
    && ln -s "$(npm root -g)/@types" node_modules/@types \
    && tsc -p tsconfig.build.json

# ---------- runtime ----------
FROM node:22-alpine AS runtime

# git: required at runtime - the service spawns `git http-backend` and `git init --bare`.
# ca-certificates: litestream needs TLS to reach object storage.
RUN apk add --no-cache git ca-certificates

# Litestream wraps the node process (see ENTRYPOINT): on a Fly machine there is one container, so it
# cannot be a compose sidecar. Wrapping also gives restore-before-serve ordering on a cold start.
ARG LITESTREAM_VERSION=0.3.13
RUN wget -qO /tmp/litestream.tar.gz \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.tar.gz" \
    && tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream \
    && rm /tmp/litestream.tar.gz

WORKDIR /app
COPY --from=build /app/apps/sync/dist ./dist
COPY infra/litestream.yml /etc/litestream.yml

ENV NODE_ENV=production \
    BUILDEX_DATA_DIR=/srv/buildex \
    PORT=8080
EXPOSE 8080
VOLUME ["/srv/buildex"]

ENTRYPOINT ["litestream", "replicate", "-config", "/etc/litestream.yml", "-exec", "node /app/dist/main.js"]
