FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# The database and witness photos live in /app/data: mount a persistent disk there.
VOLUME /app/data
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server/index.js"]
