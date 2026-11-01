FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils python3 python3-venv ca-certificates \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default]' \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
# Opt in on a suitably provisioned instance; the Free API stays lightweight.
ARG INSTALL_STEM_SEPARATOR=0
RUN if [ "$INSTALL_STEM_SEPARATOR" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends libsndfile1 libgomp1 && \
      python3 -m venv /opt/stems && \
      /opt/stems/bin/pip install --no-cache-dir --upgrade pip setuptools wheel && \
      /opt/stems/bin/pip install --no-cache-dir torch==2.5.1+cpu torchaudio==2.5.1+cpu --extra-index-url https://download.pytorch.org/whl/cpu && \
      /opt/stems/bin/pip install --no-cache-dir demucs==4.0.1 soundfile==0.12.1 'numpy<2' && \
      TORCH_HOME=/opt/stem-models /opt/stems/bin/python -c "from demucs.pretrained import get_model; get_model('htdemucs')" && \
      apt-get clean && rm -rf /var/lib/apt/lists/*; \
    fi
ENV TORCH_HOME=/opt/stem-models
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY contracts ./contracts
COPY scripts/separate-stems.py ./scripts/separate-stems.py
COPY scripts/stem-worker.js ./scripts/stem-worker.js
COPY scripts/ai-administrator-worker.js ./scripts/ai-administrator-worker.js
RUN mkdir -p /app/.runtime/stems && chown -R node:node /app/.runtime
COPY scripts/music-ontology-migrate.js ./scripts/music-ontology-migrate.js
RUN node -e "require('./src/music-ontology/models'); require('./src/music-ontology/validation')"
ENV NODE_ENV=production YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp FFMPEG_PATH=/usr/bin/ffmpeg YOUTUBE_PROCESSING_MODE=server MUSIC_ARCHIVE_STORAGE_PROVIDER=cloudinary
USER node
CMD ["npm", "start"]
