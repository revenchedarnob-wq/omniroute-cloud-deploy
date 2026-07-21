FROM diegosouzapw/omniroute:3.8.48

EXPOSE 20128

# The upstream image entrypoint is incompatible with Render command overrides.
ENTRYPOINT ["node"]
CMD ["dev/run-standalone.mjs"]
