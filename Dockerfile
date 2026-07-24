# syntax=docker/dockerfile:1.7
# 9Router v0.5.40 (upstream source 79918c7830695bbca4a45c9fea4a42c3e9fd73d1)
FROM decolua/9router@sha256:9c1f509f0045ee604657f96093a20154e811674f005b75bb37639a543cd5e10d AS builder

USER root
WORKDIR /build
RUN apk --no-cache add python3 make g++ linux-headers
ADD --checksum=sha256:bfa3304b5756684a67fb2b59da954ce26e2d1875f72fb62a5521f5c92df7bd43 \
    https://codeload.github.com/decolua/9router/tar.gz/79918c7830695bbca4a45c9fea4a42c3e9fd73d1 /tmp/9router.tar.gz
RUN tar -xzf /tmp/9router.tar.gz --strip-components=1 -C /build && npm install
COPY overrides/open-sse/ /build/open-sse/
RUN npm run build

FROM decolua/9router@sha256:9c1f509f0045ee604657f96093a20154e811674f005b75bb37639a543cd5e10d

USER root
COPY --from=builder --chown=node:node /build/public /app/public
COPY --from=builder --chown=node:node /build/.next/static /app/.next/static
COPY --from=builder --chown=node:node /build/.next/standalone /app/
COPY --from=builder --chown=node:node /build/custom-server.js /app/custom-server.js
COPY --from=builder --chown=node:node /build/open-sse /app/open-sse
COPY --from=builder --chown=node:node /build/src/mitm /app/src/mitm
COPY --from=builder --chown=node:node /build/node_modules/node-forge /app/node_modules/node-forge
COPY --from=builder --chown=node:node /build/node_modules/next /app/node_modules/next
COPY --chown=node:node cloud-runner.mjs migrate-omniroute.mjs startup.sh /app/
RUN chmod +x /app/startup.sh

ENV DATA_DIR=/app/data
ENV PORT=20128
ENV HOSTNAME=0.0.0.0

EXPOSE 20128

ENTRYPOINT ["/app/startup.sh"]
