FROM diegosouzapw/omniroute:3.8.48

EXPOSE 20128

CMD ["/bin/sh", "-lc", "printf %s \"$CLOUD_ENTRYPOINT_B64\" | base64 -d > /tmp/cloud-entrypoint.mjs && exec node /tmp/cloud-entrypoint.mjs"]
