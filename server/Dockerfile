FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# whatever permissions the files had in the package (a tarball made on a Mac keeps 0700), the app runs as the non-root user `node`: make everything readable
RUN chmod -R a+rX /app
ENV NODE_ENV=production DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data && ln -s /data /app/data
VOLUME /data
EXPOSE 3000 1935 8000
USER node
CMD ["node", "server.js"]
