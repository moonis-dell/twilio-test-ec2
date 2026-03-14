// src/websocket/mediaStream.js
'use strict';

const { workerPool }                      = require('../pool/workerPool');
const { sendAudioToTwilio, clearTwilioAudio } = require('../utils/audioSender');

async function mediaStreamRoute(fastify) {
  fastify.get('/media-stream', { websocket: true }, (connection, request) => {
    const socket            = connection.socket;
    const clientInfo        = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
    const connectionStartAt = Date.now();

    fastify.log.info(`[WS] New connection from ${clientInfo}`);

    // TCP keep-alive
    const tcpSocket = socket._socket;
    if (tcpSocket?.setKeepAlive) {
      tcpSocket.setKeepAlive(true, 30_000);
      tcpSocket.setNoDelay(true);
    }

    // Per-connection state
    let streamSid  = null;
    let callSid    = null;
    let frameCount = 0;
    let echoCount  = 0;
    let lastMsgAt  = Date.now();

    const INACTIVITY_MS    = 2_000;
    const MARK_INTERVAL_MS = 15_000;
    let inactivityTimer    = null;
    let markTimer          = null;

    // Serialized socket writes
    let writeQueue = Promise.resolve();
    const safeSend = (data) => {
      writeQueue = writeQueue
        .then(() => new Promise((resolve, reject) => {
          if (socket.readyState !== 1) return reject(new Error('Socket not OPEN'));
          socket.send(data, (err) => (err ? reject(err) : resolve()));
        }))
        .catch((err) => fastify.log.error(`[WS] safeSend error: ${err.message}`));
      return writeQueue;
    };

    // Inactivity monitor
    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fastify.log.warn(`[WS] No message for ${Date.now() - lastMsgAt}ms streamSid=${streamSid}`);
      }, INACTIVITY_MS);
    };

    // Mark heartbeat
    const sendMark = (label = `hb-${Date.now()}`) => {
      if (!streamSid) return;
      safeSend(JSON.stringify({ event: 'mark', streamSid, mark: { name: label } }));
    };
    const startHeartbeat = () => {
      stopHeartbeat();
      markTimer = setInterval(sendMark, MARK_INTERVAL_MS);
      sendMark();
    };
    const stopHeartbeat = () => {
      if (markTimer) { clearInterval(markTimer); markTimer = null; }
    };

    // Message handler
    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.event) {

          case 'connected':
            fastify.log.info(`[WS] connected protocol=${msg.protocol}`);
            lastMsgAt = Date.now();
            resetInactivityTimer();
            break;

          case 'start':
            streamSid = msg.start.streamSid;
            callSid   = msg.start.callSid;
            fastify.log.info(
              `[WS] stream started streamSid=${streamSid} callSid=${callSid} ` +
              `tracks=${JSON.stringify(msg.start.tracks)}`
            );
            lastMsgAt = Date.now();
            resetInactivityTimer();
            startHeartbeat();
            break;

          case 'media': {
            // Only process inbound track
            if (msg.media?.track === 'outbound') break;
            if (!msg.media?.payload) break;

            frameCount++;

            if (workerPool.queue.length > 100) {
              fastify.log.warn(`[WS] Queue overflow, dropping frame ${frameCount}`);
              break;
            }

            try {
              // Decode µ-law → PCM in worker thread
              // Result: { pcm: Buffer, int16: Int16Array }
              const { pcm: pcmBuf, int16 } = await workerPool.execute({
                payloadBase64: msg.media.payload,
                streamSid,
                timestamp:     msg.media.timestamp
            });

              // Echo audio back to caller
              // int16 (Int16Array) is passed directly — no conversion needed
              sendAudioToTwilio({
                socket,
                streamSid,
                int16,     // ← Int16Array, correct type for alawmulaw.mulaw.encode()
                pcmBuf,    // ← Buffer fallback (not used when int16 is present)
                safeSend,
                log: fastify.log
              });

              echoCount++;
              lastMsgAt = Date.now();
              resetInactivityTimer();

              if (frameCount % 100 === 0) {
                fastify.log.debug(
                  `[WS] frames=${frameCount} echoed=${echoCount} pool=${JSON.stringify(workerPool.getStats())}`
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
            fastify.log.info(`[WS] stream stopped streamSid=${streamSid} frames=${frameCount} echoed=${echoCount}`);
            clearTwilioAudio({ safeSend, streamSid });
            lastMsgAt = Date.now();
            resetInactivityTimer();
            break;

          case 'closed':
            fastify.log.info(`[WS] Twilio closed event streamSid=${streamSid}`);
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

    socket.on('close', (code, reason) => {
      const duration = Date.now() - connectionStartAt;
      fastify.log.warn({
        event: 'ws_closed', code,
        reason: reason.toString() || 'N/A',
        duration_ms: duration,
        duration_s: (duration / 1000).toFixed(2),
        streamSid, callSid, frameCount, echoCount,
        pool: workerPool.getStats(),
        memMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
        clientInfo
      });
      clearTimeout(inactivityTimer);
      stopHeartbeat();
      streamSid = null; callSid = null; frameCount = 0; echoCount = 0;
    });

    socket.on('error', (err) => fastify.log.error(`[WS] socket error [${clientInfo}]: ${err.message}`));
    socket.on('ping',  () => fastify.log.debug(`[WS] ping from ${clientInfo}`));
    socket.on('pong',  () => fastify.log.debug(`[WS] pong from ${clientInfo}`));
  });
}

module.exports = mediaStreamRoute;
