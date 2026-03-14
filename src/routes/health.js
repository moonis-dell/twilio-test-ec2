// src/routes/health.js
'use strict';

const { workerPool } = require('../pool/workerPool');

async function healthRoutes(fastify) {
  /**
   * GET /health
   * Standard health check used by load balancers and monitoring tools.
   */
  fastify.get('/health', async (request, reply) => {
    const mem = process.memoryUsage();
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime().toFixed(2),
      pool: workerPool.getStats(),
      memory: {
        heapUsedMB:  (mem.heapUsed  / 1024 / 1024).toFixed(2),
        heapTotalMB: (mem.heapTotal / 1024 / 1024).toFixed(2),
        rssMB:       (mem.rss       / 1024 / 1024).toFixed(2)
      }
    };
  });
}

module.exports = healthRoutes;
