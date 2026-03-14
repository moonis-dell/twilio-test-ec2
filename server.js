// server.js - Entry point
'use strict';

const app = require('./src/app');

const start = async () => {
  try {
    const port = process.env.PORT || 8000;
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ host, port });

    app.log.info(
      `\n╔═══════════════════════════════════════════════╗` +
      `\n║   🚀 Twilio Media Stream Server               ║` +
      `\n║   📡 Listening : ${host}:${port}              ║` +
      `\n║   🔗 WS Endpoint: /media-stream               ║` +
      `\n║   📞 POST Endpoint: /call                     ║` +
      `\n║   ❤️  Health: /health                         ║` +
      `\n╚═══════════════════════════════════════════════╝`
    );
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
