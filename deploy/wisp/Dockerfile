FROM node:22-alpine

RUN npm install --global @mercuryworkshop/wisp-js@0.4.1
USER node
EXPOSE 5001
ENTRYPOINT ["wisp-js-server", "--host", "0.0.0.0", "--port", "5001", "--config", "/etc/kcode-wisp/options.json"]
