FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY src ./src
COPY public ./public
USER node
EXPOSE 4000
CMD ["node", "src/server.mjs"]