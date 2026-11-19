FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json index.mjs ffmpeg.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "index.mjs"]
