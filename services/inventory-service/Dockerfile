# Use Debian-based Node image
FROM node:20-slim

# Install OpenSSL (required by Prisma)
RUN apt-get update -y && apt-get install -y openssl libssl-dev curl

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the NestJS app
RUN npm run build

# Expose service port
EXPOSE 3003

# Run migrations and seed (optional) then start app
CMD sh -c "npx prisma migrate deploy && npx ts-node prisma/seed.ts || true && node dist/main.js"