FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install --legacy-peer-deps

COPY . .
RUN npm run build

FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

COPY --from=builder /app/dist ./dist

EXPOSE 3002

CMD ["node", "dist/index.js"]
