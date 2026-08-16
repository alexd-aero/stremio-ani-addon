# Container image for the add-on (the scraper/manifest server).
# It is meant to run WITH a FlareSolverr instance — set FLARESOLVERR_URL.
# (From a datacenter IP, plain curl/Node can't clear anidb's Cloudflare, so
#  FlareSolverr's headless Chromium is what makes hosted/serverless work.)
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY index.js ./

ENV PORT=7000
EXPOSE 7000
CMD ["node", "index.js"]
