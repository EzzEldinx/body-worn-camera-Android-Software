FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000 1935 8000
USER node
CMD ["node", "server.js"]
