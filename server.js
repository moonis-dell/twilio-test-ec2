// server.js
const fastify = require('fastify')({ logger: true });
const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------
// Register websocket plugin
// ---------------------------------------------------------------
fastify.register(require('@fastify/websocket'));

// ---------------------------------------------------------------
// Global error handler (covers HTTP routes)
// ---------------------------------------------------------------
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(`[GLOBAL] ${error}`);
  reply.code(500).send({ error: 'Internal server error' });
});

// ---------------------------------------------------------------
// Worker-thread pool with fixed race condition (taskId matching)
// ---------------------------------------------------------------
class WorkerPool {
  constructor(size = os.cpus().length) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.pendingTasks = new Map();
    this.stats = { queued: 0, completed: 0, errors: 0 };
    this._init();
  }

  _init() {
    fastify.log.info(`[POOL] Initializing worker pool with ${this.size} workers`);
    for (let i = 0; i < this.size; i++) {
      this._createWorker(i);
    }
  }

  _createWorker(id) {
    const worker = new Worker(path.resolve(__dirname, 'workerDecode.js'));
    worker.workerId = id;
    worker.isBusy = false;

    worker.on('message', (msg) => {
      worker.isBusy = false;

      // FIX: Use taskId for exact matching (not streamSid)
      const pending = this.pendingTasks.get(msg.taskId);

      if (pending) {
        this.pendingTasks.delete(msg.taskId);
        if (msg.err) {
          this.stats.errors++;
          pending.reject(new Error(msg.err));
        } else {
          this.stats.completed++;
          pending.resolve(msg.pcm);
        }
      } else {
        fastify.log.error(`[POOL] Orphaned response for taskId: ${msg.taskId}`);
      }

      this._processQueue();
    });

    worker.on('error', (err) => {
      fastify.log.error(`[POOL] Worker ${id} error: ${err}`);
      worker.isBusy = false;
      this._processQueue();
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        fastify.log.warn(`[POOL] Worker ${id} exited with code ${code}, respawning...`);
        const idx = this.workers.indexOf(worker);
        if (idx >= 0) {
          this.workers.splice(idx, 1);
          this._createWorker(id);
        }
      }
    });

    this.workers.push(worker);
  }

  execute(msg) {
    this.stats.queued++;

    return new Promise((resolve, reject) => {
      // FIX: Use unique taskId (streamSid + timestamp + random) for exact matching
      const taskId = `${msg.streamSid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Timeout to prevent hanging promises
      const timeout = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        this.stats.errors++;
        reject(new Error(`Worker timeout after 5000ms, queue depth: ${this.queue.length}`));
      }, 5000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this.queue.push({ msg: { ...msg, taskId }, taskId });
      this._processQueue();
    });
  }

  _processQueue() {
    while (this.queue.length > 0) {
      const freeWorker = this.workers.find(w => !w.isBusy);
      if (!freeWorker) break;

      const { msg, taskId } = this.queue.shift();
      freeWorker.isBusy = true;
      freeWorker.postMessage(msg);
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueDepth: this.queue.length,
      pendingTasks: this.pendingTasks.size,
      busyWorkers: this.workers.filter(w => w.isBusy).length,
      totalWorkers: this.workers.length
    };
  }

  async terminateAll() {
    fastify.log.info('[POOL] Terminating all workers...');
    const promises = this.workers.map(w => w.terminate());
    await Promise.all(promises);
  }
}

const workerPool = new WorkerPool();

// ---------------------------------------------------------------
// WebSocket route for Twilio Media Stream
// ---------------------------------------------------------------
fastify.get('/media-stream', { websocket: true }, (connection, request) => {
  const socket = connection.socket;
  const clientInfo = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  const connectionStartTime = Date.now();

  fastify.log.info(`[WS] New connection from ${clientInfo}`);

  // Enable TCP keep-alive on the underlying TCP socket
  const tcpSocket = socket._socket;
  if (tcpSocket && tcpSocket.setKeepAlive) {
    tcpSocket.setKeepAlive(true, 30000); // 30s initial delay
    tcpSocket.setNoDelay(true);           // Disable Nagle's algorithm
    fastify.log.debug('[WS] TCP keep-alive and no-delay enabled');
  }

  // ---------- Connection state ----------
  let streamSid = null;
  let callSid = null;
  let lastMsgAt = Date.now();
  const INACTIVITY_MS = 2000;
  let inactivityTimer = null;
  const MARK_INTERVAL_MS = 15000;
  let markTimer = null;
  let frameCount = 0;

  // ---------- Serialized socket writes (prevents concurrent write race) ----------
  let writeQueue = Promise.resolve();
  const safeSend = (data) => {
    writeQueue = writeQueue.then(() => {
      return new Promise((resolve, reject) => {
        if (socket.readyState !== 1) { // 1 = WebSocket.OPEN
          reject(new Error('Socket not open'));
          return;
        }
        socket.send(data, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }).catch(err => {
      fastify.log.error(`[WS] safeSend error [${clientInfo}]: ${err.message}`);
    });
    return writeQueue;
  };

  // ---------- Inactivity detection ----------
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      const silentFor = Date.now() - lastMsgAt;
      fastify.log.warn(
        `[WS] No Twilio message for ${silentFor}ms from ${clientInfo} (streamSid: ${streamSid})`
      );
      // Uncomment to terminate on inactivity:
      // socket.terminate();
    }, INACTIVITY_MS);
  };

  const startInactivityMonitor = () => {
    resetInactivityTimer();
  };

  // ---------- Mark-based heartbeat (uses Twilio echo, not WebSocket ping/pong) ----------
  const sendMark = () => {
    if (!streamSid) return;
    const markName = `heartbeat-${Date.now()}`;
    const markMsg = JSON.stringify({
      event: 'mark',
      streamSid,
      mark: { name: markName }
    });
    safeSend(markMsg); // Uses serialized send queue
  };

  const startMarkHeartbeat = () => {
    if (markTimer) clearInterval(markTimer);
    markTimer = setInterval(sendMark, MARK_INTERVAL_MS);
    sendMark(); // Immediate first mark
  };

  const stopMarkHeartbeat = () => {
    if (markTimer) {
      clearInterval(markTimer);
      markTimer = null;
    }
  };

  // ---------- Message handling (non-blocking) ----------
  socket.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const { event } = msg;

      switch (event) {
        case 'connected':
          fastify.log.debug(`[WS] Connected event: ${msg.protocol}`);
          // Reset timer for non-media events immediately
          lastMsgAt = Date.now();
          resetInactivityTimer();
          break;

        case 'start':
          streamSid = msg.start.streamSid;
          callSid = msg.start.callSid;
          fastify.log.info(
            `[WS] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}, Track: ${msg.start.track}`
          );
          lastMsgAt = Date.now();
          resetInactivityTimer();
          startInactivityMonitor();
          startMarkHeartbeat();
          break;

        case 'media':
          if (msg.media.payload) {
            frameCount++;

            // Backpressure check
            if (workerPool.queue.length > 100) {
              fastify.log.warn(
                `[WS] Queue overflow (${workerPool.queue.length}), dropping frame ${frameCount} for ${streamSid}`
              );
              return;
            }

            try {
              // Offload µ-law → PCM decode to worker pool (non-blocking)
              const pcmBuf = await workerPool.execute({
                payloadBase64: msg.media.payload,
                streamSid,
                timestamp: msg.media.timestamp
              });

              // FIX: Reset inactivity timer AFTER successful processing
              lastMsgAt = Date.now();
              resetInactivityTimer();

              // ---- PCM BUFFER READY ----
              // Replace this with your actual implementation:
              // • Send to OpenAI Realtime API
              // • Write to WAV file
              // • Forward to AI model
              if (frameCount % 100 === 0) {
                fastify.log.debug(
                  `[WS] Processed ${frameCount} frames for ${streamSid}, PCM: ${pcmBuf.length} bytes, Pool: ${JSON.stringify(workerPool.getStats())}`
                );
              }
            } catch (err) {
              fastify.log.error(`[WS] Decode error for ${streamSid}: ${err.message}`);
            }
          }
          break;

        case 'mark':
          // Twilio echoes back the mark we sent
          fastify.log.debug(
            `[WS] Mark echo received: ${msg.mark.name} (streamSid: ${msg.streamSid})`
          );
          lastMsgAt = Date.now();
          resetInactivityTimer();
          break;

        case 'stop':
          fastify.log.info(
            `[WS] Stream ended normally - StreamSid: ${streamSid}, CallSid: ${callSid}, Frames: ${frameCount}`
          );
          // DO NOT close socket here - let Twilio manage the lifecycle
          lastMsgAt = Date.now();
          resetInactivityTimer();
          break;

        case 'closed':
          fastify.log.info(`[WS] Received explicit closed event from Twilio for ${streamSid}`);
          break;

        default:
          fastify.log.debug(`[WS] Unhandled event: ${event}`);
          lastMsgAt = Date.now();
          resetInactivityTimer();
      }
    } catch (e) {
      fastify.log.error(`[WS] Message parse/processing error [${clientInfo}]: ${e.message}`);
    }
  });

  // ---------- Socket-level events ----------
  socket.on('close', (code, reason) => {
    const duration = Date.now() - connectionStartTime;
    fastify.log.warn({
      event: 'websocket_closed',
      code,
      reason: reason.toString() || 'N/A',
      duration_ms: duration,
      duration_sec: (duration / 1000).toFixed(2),
      streamSid,
      callSid,
      frameCount,
      poolStats: workerPool.getStats(),
      memoryMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      uptime: process.uptime().toFixed(2),
      clientInfo
    });

    // Clean up all timers
    if (inactivityTimer) clearTimeout(inactivityTimer);
    stopMarkHeartbeat();

    // Clean up connection-specific state
    streamSid = null;
    callSid = null;
    frameCount = 0;
  });

  socket.on('error', (err) => {
    fastify.log.error(`[WS] Socket error [${clientInfo}]: ${err.message}`);
  });

  socket.on('unexpected-response', (req, res) => {
    fastify.log.warn(
      `[WS] Unexpected HTTP response [${clientInfo}]: ${res.statusCode}`
    );
  });

  socket.on('ping', () => {
    fastify.log.debug(`[WS] Ping received from ${clientInfo}`);
  });

  socket.on('pong', () => {
    fastify.log.debug(`[WS] Pong received from ${clientInfo}`);
  });
});

// ---------------------------------------------------------------
// Health check endpoint
// ---------------------------------------------------------------
fastify.get('/health', async (request, reply) => {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime().toFixed(2),
    workers: workerPool.size,
    poolStats: workerPool.getStats(),
    memory: {
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (process.memoryUsage().heapTotal / 1024 / 1024).toFixed(2),
      rssMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2)
    }
  };
});

// ---------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------
const start = async () => {
  try {
    const port = process.env.PORT || 8000;
    const host = process.env.HOST || '0.0.0.0';

    await fastify.listen({ host, port });

    fastify.log.info(
      `\n╔═══════════════════════════════════════════╗\n║  Twilio Media Stream Server               ║\n║  Listening on ${host}:${port}             ║\n║  Worker pool: ${workerPool.size} threads              ║\n║  WebSocket: ws://${host}:${port}/media-stream ║\n╚═══════════════════════════════════════════╝`
    );
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

// ---------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------
const gracefulShutdown = async (signal) => {
  fastify.log.info(`${signal} received - shutting down gracefully...`);
  try {
    await workerPool.terminateAll();
    await fastify.close();
    fastify.log.info('Server shut down successfully');
    process.exit(0);
  } catch (err) {
    fastify.log.error('Error during shutdown:', err);
    process.exit(1);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught exceptions - log but do NOT exit for single bad request
process.on('uncaughtException', (err) => {
  fastify.log.error('Uncaught exception:', err);
  // Only exit for critical errors
  if (err.code === 'EADDRINUSE') {
    gracefulShutdown('uncaughtException');
  }
});

process.on('unhandledRejection', (reason, promise) => {
  fastify.log.error('Unhandled rejection at:', promise, 'reason:', reason);
});
