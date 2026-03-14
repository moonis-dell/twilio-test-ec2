// src/app.js
'use strict';

const fastify = require('fastify')({
  logger: { level: process.env.LOG_LEVEL || 'info' }
});

// ── Plugins ───────────────────────────────────────────────────────────────────
fastify.register(require('@fastify/websocket'));
fastify.register(require('@fastify/formbody'));

// ── Global error handler ──────────────────────────────────────────────────────
fastify.setErrorHandler((error, _request, reply) => {
  fastify.log.error(`[GLOBAL] ${error}`);
  reply.code(500).send({ error: 'Internal server error' });
});

// ── Routes ────────────────────────────────────────────────────────────────────
fastify.register(require('./routes/health'),         { prefix: '/' });
fastify.register(require('./routes/twilio'),         { prefix: '/' });
fastify.register(require('./websocket/mediaStream'), { prefix: '/' });

// ── Process-level safety nets ─────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  fastify.log.error('[PROCESS] Uncaught exception:', err);
  if (err.code === 'EADDRINUSE') process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  fastify.log.error('[PROCESS] Unhandled rejection:', reason);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const { workerPool } = require('./pool/workerPool');

const gracefulShutdown = async (signal) => {
  fastify.log.info(`[SHUTDOWN] ${signal} received`);
  try {
    // Step 1: Terminate all open WebSocket connections immediately.
    // MUST use ws.terminate() NOT ws.close() — ws.close() has a 30-second
    // default timeout that blocks the process from exiting cleanly.
    // terminate() destroys the TCP socket instantly with no handshake.
    const wsServer = fastify.websocketServer;
    if (wsServer) {
      for (const client of wsServer.clients) {
        try { client.terminate(); } catch (_) {}
      }
      fastify.log.info(`[SHUTDOWN] Terminated ${wsServer.clients.size} WebSocket client(s)`);
    }

    // Step 2: Shut down worker threads
    await workerPool.terminateAll();

    // Step 3: Close Fastify (HTTP server) — safe now, no open WS connections
    await fastify.close();

    fastify.log.info('[SHUTDOWN] Clean exit');
    process.exit(0);
  } catch (err) {
    fastify.log.error('[SHUTDOWN] Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = fastify;
