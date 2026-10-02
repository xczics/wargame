# Self-hosted Wargame: the production build served by workerd (the same runtime as Cloudflare, via
# `vite preview`), with its D1 database and maps on the /data volume. See docs/deployment.md, "Docker".
#
#   docker run -d --name wargame -p 4173:4173 -v wargame:/data ghcr.io/xczics/wargame
#
# Then log in as gm / wargame-gm: that is only the initial password, the game asks for your own at once.
#
# workerd needs glibc: a Debian base, not Alpine.
FROM node:24-bookworm-slim

WORKDIR /app
RUN corepack enable

# Dependencies first, so code changes reuse this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV WARGAME_DATA_DIR=/data/local \
	WARGAME_MAPS_DIR=/data/maps \
	NODE_ENV=production \
	GM_USERNAME=gm \
	GM_PASSWORD=wargame-gm
VOLUME /data
EXPOSE 4173

# Applies the migrations, gives a fresh game its map (the newest in /data/maps, else a new one), serves on
# port 4173 and runs the background tasks every minute.
CMD ["node", "scripts/dev.mjs", "--serve"]
