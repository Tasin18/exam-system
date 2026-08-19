# node:sqlite is only available without a runtime flag from Node 23.4 onward,
# and this app stores every quiz, attempt and result in it. Pinning the major
# version here stops a base-image refresh silently moving off that.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is only rebuilt when the lockfile changes, so
# an edit to a question template does not re-download the whole tree.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# The database lives on a mounted volume, not in the image. Without this the
# whole exam - including attempts already submitted - is lost on every deploy.
ENV DB_FILE=/data/exam.db
VOLUME /data

# Overridden by the platform; declared so `docker run -p 3000:3000` just works.
ENV PORT=3000
EXPOSE 3000

# Runs unprivileged. Nothing here needs root, and an exam server is exactly the
# kind of long-running public process where that matters.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Both the platform and a plain `docker run` get a real readiness signal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
