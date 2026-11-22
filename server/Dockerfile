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
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
