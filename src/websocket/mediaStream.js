// src/websocket/mediaStream.js
// WebSocket handler for Twilio Media Streams
'use strict';

const { workerPool } = require('../pool/workerPool');

async function mediaStreamRoute(fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, request) => {
    const socket            = connection.socket;
    const clientInfo        = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
    const connectionStartAt = Date.now();

    fastify.log.info(`[WS] New connection from ${clientInfo}`);

    // ── Enable TCP keep-alive on the raw socket ───────────────────────────────
    const tcpSocket = socket._socket;
    if (tcpSocket?.setKeepAlive) {
      tcpSocket.setKeepAlive(true, 30_000); // first probe after 30 s idle
      tcpSocket.setNoDelay(true);            // disable Nagle (reduce latency)
    }

    // ── Per-connection state ──────────────────────────────────────────────────
    let streamSid  = null;
    let callSid    = null;
    let frameCount = 0;
    let lastMsgAt  = Date.now();

    const INACTIVITY_MS    = 2_000;   // warn if silent > 2 s
    const MARK_INTERVAL_MS = 15_000;  // send mark heartbeat every 15 s

    let inactivityTimer = null;
    let markTimer       = null;

    // ── Serialized socket writes (prevents concurrent-write race) ─────────────
    let writeQueue = Promise.resolve();

    const safeSend = (data) => {
      writeQueue = writeQueue
        .then(() => new Promise((resolve, reject) => {
          if (socket.readyState !== 1) { // 1 = OPEN
            return reject(new Error('Socket not OPEN'));
          }
          socket.send(data, (err) => (err ? reject(err) : resolve()));
        }))
        .catch((err) => {
          fastify.log.error(`[WS] safeSend error [${clientInfo}]: ${err.message}`);
        });
      return writeQueue;
    };

    // ── Inactivity monitor ────────────────────────────────────────────────────
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fastify.log.warn(
          `[WS] No message for ${Date.now() - lastMsgAt}ms [${clientInfo}] streamSid=${streamSid}`
        );
        // socket.terminate(); // Uncomment to hard-kill stale connections
      }, INACTIVITY_MS);
    };

    // ── Mark-based heartbeat (Twilio echoes marks back) ───────────────────────
    const sendMark = () => {
      if (!streamSid) return;
      safeSend(JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: `hb-${Date.now()}` }
      }));
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      markTimer = setInterval(sendMark, MARK_INTERVAL_MS);
      sendMark(); // immediate first probe
    };

    const stopHeartbeat = () => {
      if (markTimer) { clearInterval(markTimer); markTimer = null; }
    };

    // ── Message handler ───────────────────────────────────────────────────────
    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.event) {
          case 'connected':
            fastify.log.debug(`[WS] connected protocol=${msg.protocol}`);
            lastMsgAt = Date.now();
            resetInactivityTimer();
            break;

          case 'start':
            streamSid = msg.start.streamSid;
            callSid   = msg.start.callSid;
            fastify.log.info(
              `[WS] stream started streamSid=${streamSid} callSid=${callSid} track=${msg.start.track}`
            );
            lastMsgAt = Date.now();
            resetInactivityTimer();
            startHeartbeat();
            break;

          case 'media': {
            if (!msg.media?.payload) break;
            frameCount++;

            // Back-pressure guard
            if (workerPool.queue.length > 100) {
              fastify.log.warn(`[WS] Queue overflow – dropping frame ${frameCount} (streamSid=${streamSid})`);
              break;
            }

            try {
              const pcmBuf = await workerPool.execute({
                payloadBase64: msg.media.payload,
                streamSid,
                timestamp: msg.media.timestamp
              });

              // ── YOUR AUDIO CONSUMER GOES HERE ──────────────────────────────
              // e.g. openaiRealtimeClient.sendAudio(pcmBuf);
              // e.g. wavWriter.write(pcmBuf);
              // ───────────────────────────────────────────────────────────────

              lastMsgAt = Date.now();
              resetInactivityTimer();

              if (frameCount % 100 === 0) {
                fastify.log.debug(
                  `[WS] frames=${frameCount} pcmBytes=${pcmBuf.length} pool=${JSON.stringify(workerPool.getStats())}`
                );
              }
            } catch (err) {
              fastify.log.error(`[WS] decode error streamSid=${streamSid}: ${err.message}`);
            }
            break;
          }

          case 'mark':
            fastify.log.debug(`[WS] mark echo name=${msg.mark?.name}`);
            lastMsgAt = Date.now();
            resetInactivityTimer();
            break;

          case 'stop':
            fastify.log.info(
              `[WS] stream stopped streamSid=${streamSid} frames=${frameCount}`
            );
            lastMsgAt = Date.now();
            resetInactivityTimer();
            // DO NOT close socket – let Twilio manage lifecycle
            break;

          case 'closed':
            fastify.log.info(`[WS] Twilio sent closed event streamSid=${streamSid}`);
            break;

          default:
            fastify.log.debug(`[WS] unhandled event=${msg.event}`);
            lastMsgAt = Date.now();
            resetInactivityTimer();
        }
      } catch (err) {
        fastify.log.error(`[WS] message error [${clientInfo}]: ${err.message}`);
      }
    });

    // ── Socket-level events ───────────────────────────────────────────────────
    socket.on('close', (code, reason) => {
      const duration = Date.now() - connectionStartAt;
      fastify.log.warn({
        event:       'ws_closed',
        code,
        reason:      reason.toString() || 'N/A',
        duration_ms: duration,
        duration_s:  (duration / 1000).toFixed(2),
        streamSid,
        callSid,
        frameCount,
        pool:        workerPool.getStats(),
        memMB:       (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
        clientInfo
      });

      clearTimeout(inactivityTimer);
      stopHeartbeat();

      // Nullify references to help GC
      streamSid  = null;
      callSid    = null;
      frameCount = 0;
    });

    socket.on('error', (err) => {
      fastify.log.error(`[WS] socket error [${clientInfo}]: ${err.message}`);
    });

    socket.on('unexpected-response', (_req, res) => {
      fastify.log.warn(`[WS] unexpected HTTP ${res.statusCode} [${clientInfo}]`);
    });

    socket.on('ping', () => fastify.log.debug(`[WS] ping from ${clientInfo}`));
    socket.on('pong', () => fastify.log.debug(`[WS] pong from ${clientInfo}`));
  });
}

module.exports = mediaStreamRoute;
