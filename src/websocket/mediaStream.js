// src/websocket/mediaStream.js
'use strict';

const { workerPool }        = require('../pool/workerPool');
const { clearTwilioAudio }  = require('../utils/audioSender');
const { AzureTTSService }   = require('../services/azureTts');
const { ChunkStream }       = require('../utils/chunkStream');
const { FramePacer }        = require('../utils/framePacer');

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

const TTS_INTERVAL_MS = 10_000;

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

    // Active pacer — only one TTS utterance plays at a time
    let activePacer = null;

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

    // ── Azure TTS → ChunkStream → FramePacer → Twilio ────────────────────────
    //
    // 1. Azure HTTP stream  →  arbitrary sized mulaw chunks
    // 2. ChunkStream        →  slices into exact 160-byte frames
    // 3. FramePacer         →  queues frames, fires one every 20ms via setInterval
    // 4. safeSend           →  serialized WS write to Twilio
    //
    const speakText = async (text) => {
      if (!streamSid || socket.readyState !== 1) return;

      // Stop any currently playing audio before starting new one
      if (activePacer) {
        activePacer.stop();
        activePacer = null;
      }

      try {
        fastify.log.info(`[TTS] Speaking (${text.length} chars): "${text.substring(0, 60)}"`);

        const azureStream = await tts.getStream(text, { emotion: 'cheerful' });
        const chunker     = new ChunkStream(160);

        // Create a new pacer for this utterance
        const pacer = new FramePacer({ streamSid, safeSend, log: fastify.log });
        activePacer = pacer;

        // Pipe Azure → ChunkStream → FramePacer
        azureStream.pipe(chunker);

        await new Promise((resolve, reject) => {
          chunker.on('data',  (frame) => pacer.push(frame));
          chunker.on('end',   () => {
            pacer.flush();    // tell pacer to stop timer after draining queue
            resolve();
          });
          chunker.on('error', reject);
          azureStream.on('error', reject);
        });

        ttsCount++;
        fastify.log.info(
          `[TTS] Buffered msg #${ttsCount} — frames=${pacer.pending + pacer.sent} streamSid=${streamSid}`
        );

      } catch (err) {
        if (err.name !== 'AbortError') {
          fastify.log.error(`[TTS] speakText error: ${err.message}`);
        }
      }
    };
    // ─────────────────────────────────────────────────────────────────────────

    const startTtsInterval = () => {
      stopTtsInterval();
      speakText('Hello! I will send you a message every ten seconds.');
      ttsTimer = setInterval(async () => {
        const text = RANDOM_MESSAGES[msgIndex % RANDOM_MESSAGES.length];
        msgIndex++;
        await speakText(text);
      }, TTS_INTERVAL_MS);
    };

    const stopTtsInterval = () => {
      if (ttsTimer)  { clearInterval(ttsTimer); ttsTimer = null; }
      if (activePacer) { activePacer.stop(); activePacer = null; }
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
