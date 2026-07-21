FROM decolua/9router:latest

USER root
COPY --chown=node:node cloud-runner.mjs migrate-omniroute.mjs /app/

ENV DATA_DIR=/app/data
ENV PORT=20128
ENV HOSTNAME=0.0.0.0

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "/app/cloud-runner.mjs"]
