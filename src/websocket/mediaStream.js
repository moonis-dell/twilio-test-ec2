// src/websocket/mediaStream.js
'use strict';

const { workerPool }                          = require('../pool/workerPool');
const { sendAudioToTwilio, clearTwilioAudio } = require('../utils/audioSender');
const { AzureTTSService }                     = require('../services/azureTts');

// Random messages sent to caller every 10 seconds
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

const TTS_INTERVAL_MS = 10_000;  // send a TTS message every 10 seconds

async function mediaStreamRoute(fastify) {
  // Build Azure TTS service once — shared HTTPS agent across all calls
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
    let ttsCount   = 0;
    let lastMsgAt  = Date.now();
    let msgIndex   = 0;   // cycles through RANDOM_MESSAGES in order

    const INACTIVITY_MS    = 2_000;
    const MARK_INTERVAL_MS = 15_000;
    let inactivityTimer    = null;
    let markTimer          = null;
    let ttsTimer           = null;

    // Serialized socket writes — no concurrent write race
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

    // ── Azure TTS → Twilio pipeline ──────────────────────────────────────────
    // Reads the raw mulaw stream from Azure and sends each chunk directly
    // to Twilio via safeSend. No re-encoding needed — Azure outputs
    // raw-8khz-8bit-mono-mulaw which is exactly Twilio's expected format.
    const speakText = async (text) => {
      if (!streamSid || socket.readyState !== 1) return;

      try {
        fastify.log.info(`[TTS] Speaking: "${text}"`);

        const stream = await tts.getStream(text, { emotion: 'cheerful' });

        await new Promise((resolve, reject) => {
          stream.on('data', (chunk) => {
            // chunk is already raw mulaw bytes from Azure — base64 encode and send
            const payload  = chunk.toString('base64');
            const mediaMsg = JSON.stringify({
              event:     'media',
              streamSid,
              media:     { payload }
            });
            safeSend(mediaMsg);
          });

          stream.on('end',   resolve);
          stream.on('error', reject);
        });

        ttsCount++;
        fastify.log.info(`[TTS] Done speaking msg #${ttsCount}`);

      } catch (err) {
        if (err.name !== 'AbortError') {
          fastify.log.error(`[TTS] Error: ${err.message}`);
        }
      }
    };

    // Start sending TTS messages every 10 seconds once stream begins
    const startTtsInterval = () => {
      stopTtsInterval();
      ttsTimer = setInterval(async () => {
        const text = RANDOM_MESSAGES[msgIndex % RANDOM_MESSAGES.length];
        msgIndex++;
        await speakText(text);
      }, TTS_INTERVAL_MS);

      // Speak first message immediately on stream start
      speakText('Hello! I will send you a message every ten seconds.');
    };

    const stopTtsInterval = () => {
      if (ttsTimer) { clearInterval(ttsTimer); ttsTimer = null; }
    };
    // ─────────────────────────────────────────────────────────────────────────

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
            startTtsInterval();   // ← begin sending TTS every 10s
            break;

          case 'media': {
            // Skip outbound frames echoed back by Twilio
            if (msg.media?.track === 'outbound') break;
            if (!msg.media?.payload) break;

            frameCount++;

            if (workerPool.queue.length > 100) {
              fastify.log.warn(`[WS] Queue overflow, dropping frame ${frameCount}`);
              break;
            }

            try {
              // Decode inbound mulaw (used for future STT / VAD)
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
        duration_s:  (duration / 1000).toFixed(2),
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
