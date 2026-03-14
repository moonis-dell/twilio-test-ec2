// src/websocket/mediaStream.js
'use strict';

const { workerPool }                          = require('../pool/workerPool');
const { clearTwilioAudio }                    = require('../utils/audioSender');
const { AzureTTSService }                     = require('../services/azureTts');
const { ChunkStream }                         = require('../utils/chunkStream');

// Random messages cycled every 10 seconds
const RANDOM_MESSAGES = [
  'Hello! This is a test message from the server.',
  'Did you know that Node.js uses an event loop?',
  'Azure Text to Speech sounds pretty natural, right?',
  'This message was synthesized in real time.',
  'Twilio media streams make bidirectional audio easy.',
  'Your call is being processed by a Fastify server.',
  'Another random message coming your way!',
  'The quick brown fox jumps over the lazy dog.',
];

const TTS_INTERVAL_MS = 10_000;  // speak a new message every 10 seconds
const FRAME_BYTES     = 160;     // 8kHz * 8bit * 20ms = 160 bytes per frame

async function mediaStreamRoute(fastify) {
  const tts = new AzureTTSService({
    speechKey:    process.env.AZURE_SPEECH_KEY,
    speechRegion: process.env.AZURE_SPEECH_REGION,
    voiceName:    process.env.AZURE_VOICE_NAME || 'en-US-JennyNeural',
    log:          fastify.log
  });

  fastify.get('/media-stream', { websocket: true }, (connection, request) => {
    const socket            = connection.socket;
    const clientInfo        = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
    const connectionStartAt = Date.now();

    fastify.log.info(`[WS] New connection from ${clientInfo}`);

    const tcpSocket = socket._socket;
    if (tcpSocket?.setKeepAlive) {
      tcpSocket.setKeepAlive(true, 30_000);
      tcpSocket.setNoDelay(true);
    }

    // Per-connection state
    let streamSid  = null;
    let callSid    = null;
    let frameCount = 0;
    let ttsCount   = 0;
    let lastMsgAt  = Date.now();
    let msgIndex   = 0;

    const INACTIVITY_MS    = 2_000;
    const MARK_INTERVAL_MS = 15_000;
    let inactivityTimer    = null;
    let markTimer          = null;
    let ttsTimer           = null;

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

    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fastify.log.warn(`[WS] No message for ${Date.now() - lastMsgAt}ms streamSid=${streamSid}`);
      }, INACTIVITY_MS);
    };

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

    // ── Azure TTS → 160-byte frames → Twilio ─────────────────────────────────
    //
    // Pipeline:
    //   Azure HTTP stream (raw mulaw, arbitrary chunk sizes)
    //        ↓
    //   ChunkStream (slices into exact 160-byte / 20ms frames)
    //        ↓
    //   base64 encode each frame
    //        ↓
    //   safeSend({ event:'media', streamSid, media:{ payload } })
    //        ↓
    //   Twilio plays audio to caller
    //
    const speakText = async (text) => {
      if (!streamSid || socket.readyState !== 1) return;

      try {
        fastify.log.info(`[TTS] Speaking: "${text}"`);

        const azureStream = await tts.getStream(text, { emotion: 'cheerful' });
        const chunker     = new ChunkStream(FRAME_BYTES);

        // Pipe Azure stream through the 160-byte slicer
        azureStream.pipe(chunker);

        await new Promise((resolve, reject) => {
          chunker.on('data', (frame) => {
            // frame is exactly 160 bytes (or less for the final remainder)
            const payload  = frame.toString('base64');
            const mediaMsg = JSON.stringify({
              event:     'media',
              streamSid,
              media:     { payload }
            });
            safeSend(mediaMsg);
          });

          chunker.on('end',   resolve);
          chunker.on('error', reject);
          azureStream.on('error', reject);
        });

        ttsCount++;
        fastify.log.info(`[TTS] Done msg #${ttsCount} streamSid=${streamSid}`);

      } catch (err) {
        if (err.name !== 'AbortError') {
          fastify.log.error(`[TTS] speakText error: ${err.message}`);
        }
      }
    };
    // ─────────────────────────────────────────────────────────────────────────

    const startTtsInterval = () => {
      stopTtsInterval();
      // Speak greeting immediately, then every 10s
      speakText('Hello! I will send you a message every ten seconds.');
      ttsTimer = setInterval(async () => {
        const text = RANDOM_MESSAGES[msgIndex % RANDOM_MESSAGES.length];
        msgIndex++;
        await speakText(text);
      }, TTS_INTERVAL_MS);
    };

    const stopTtsInterval = () => {
      if (ttsTimer) { clearInterval(ttsTimer); ttsTimer = null; }
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
            startTtsInterval();
            break;

          case 'media': {
            if (msg.media?.track === 'outbound') break;
            if (!msg.media?.payload) break;

            frameCount++;

            if (workerPool.queue.length > 100) {
              fastify.log.warn(`[WS] Queue overflow, dropping frame ${frameCount}`);
              break;
            }

            try {
              await workerPool.execute({
                payloadBase64: msg.media.payload,
                streamSid,
                timestamp:     msg.media.timestamp
              });
              lastMsgAt = Date.now();
              resetInactivityTimer();

              if (frameCount % 100 === 0) {
                fastify.log.debug(
                  `[WS] frames=${frameCount} tts=${ttsCount} pool=${JSON.stringify(workerPool.getStats())}`
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
            fastify.log.info(`[WS] stream stopped streamSid=${streamSid} frames=${frameCount} tts=${ttsCount}`);
            stopTtsInterval();
            clearTwilioAudio({ safeSend, streamSid });
            lastMsgAt = Date.now();
            resetInactivityTimer();
            break;

          case 'closed':
            fastify.log.info(`[WS] Twilio closed streamSid=${streamSid}`);
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
        duration_ms: duration, duration_s: (duration / 1000).toFixed(2),
        streamSid, callSid, frameCount, ttsCount,
        pool:  workerPool.getStats(),
        memMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2),
        clientInfo
      });
      clearTimeout(inactivityTimer);
      stopHeartbeat();
      stopTtsInterval();
      streamSid = null; callSid = null; frameCount = 0; ttsCount = 0;
    });

    socket.on('error', (err) => fastify.log.error(`[WS] socket error [${clientInfo}]: ${err.message}`));
    socket.on('ping',  () => fastify.log.debug(`[WS] ping from ${clientInfo}`));
    socket.on('pong',  () => fastify.log.debug(`[WS] pong from ${clientInfo}`));
  });
}

module.exports = mediaStreamRoute;
