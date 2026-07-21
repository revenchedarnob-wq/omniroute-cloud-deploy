FROM decolua/9router:latest

USER root
COPY --chown=node:node cloud-runner.mjs migrate-omniroute.mjs startup.sh /app/
RUN chmod +x /app/startup.sh

ENV DATA_DIR=/app/data
ENV PORT=20128
ENV HOSTNAME=0.0.0.0

EXPOSE 20128

ENTRYPOINT ["/app/startup.sh"]
