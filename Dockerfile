# SPDX-License-Identifier: AGPL-3.0-only

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# mkdir: with no runtime dependencies, npm creates no node_modules for the COPY below.
RUN npm ci --omit=dev && mkdir -p node_modules

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
USER node
CMD ["node", "dist/index.js"]
