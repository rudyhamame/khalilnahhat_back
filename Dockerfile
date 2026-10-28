FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils python3 python3-venv ca-certificates \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]' \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp FFMPEG_PATH=/usr/bin/ffmpeg YOUTUBE_PROCESSING_MODE=server MUSIC_ARCHIVE_STORAGE_PROVIDER=cloudinary
USER node
CMD ["npm", "start"]
