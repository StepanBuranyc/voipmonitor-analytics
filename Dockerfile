FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4196

COPY package.json server.mjs ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY examples/ ./examples/

RUN mkdir /app/data && chown node:node /app/data
USER node
EXPOSE 4196

HEALTHCHECK --interval=15s --timeout=4s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4196/api/config').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
