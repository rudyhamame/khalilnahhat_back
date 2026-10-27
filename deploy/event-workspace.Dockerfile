FROM rh-khalil-archive:20261026
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
ENV NODE_ENV=production
CMD ["npm", "start"]
