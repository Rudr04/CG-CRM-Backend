FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV PORT=8080
ENV FUNCTION_TARGET=webhook
CMD ["npx", "functions-framework", "--target=webhook", "--port=8080"]