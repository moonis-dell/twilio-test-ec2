// src/app.js - Fastify app factory
'use strict';

const fastify = require('fastify')({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

// ── Plugins ──────────────────────────────────────────────────────────────────
fastify.register(require('@fastify/websocket'));
fastify.register(require('@fastify/formbody')); // parses Twilio's x-www-form-urlencoded POST

// ── Global error handler ─────────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(`[GLOBAL] ${error}`);
  reply.code(500).send({ error: 'Internal server error' });
});

// ── Routes ───────────────────────────────────────────────────────────────────
fastify.register(require('./routes/health'),  { prefix: '/' });
fastify.register(require('./routes/twilio'),  { prefix: '/' });
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
    await workerPool.terminateAll();
    await fastify.close();
    fastify.log.info('[SHUTDOWN] Clean exit');
    process.exit(0);
  } catch (err) {
    fastify.log.error('[SHUTDOWN] Error:', err);
    process.exit(1);
  }
};

process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = fastify;
