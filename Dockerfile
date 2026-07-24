# 9Router v0.5.40 (upstream source 79918c7830695bbca4a45c9fea4a42c3e9fd73d1)
FROM decolua/9router@sha256:9c1f509f0045ee604657f96093a20154e811674f005b75bb37639a543cd5e10d

USER root
COPY --chown=node:node overrides/open-sse/ /app/open-sse/
COPY --chown=node:node cloud-runner.mjs migrate-omniroute.mjs startup.sh /app/
RUN chmod +x /app/startup.sh

ENV DATA_DIR=/app/data
ENV PORT=20128
ENV HOSTNAME=0.0.0.0

EXPOSE 20128

ENTRYPOINT ["/app/startup.sh"]
