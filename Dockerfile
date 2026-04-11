FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV PORT=8080
CMD ["node", "node_modules/@google-cloud/functions-framework/build/src/main.js"]