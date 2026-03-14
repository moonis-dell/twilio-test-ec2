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

// Twilio pauses inbound frames during outbound TTS playback on <Connect><Stream>.
// 871 frames * 20ms = 17.4s observed max. 30s gives safe headroom.
const INACTIVITY_MS = 30_000;

// Mark echo dead-call detection:
// We send a mark every MARK_INTERVAL_MS. Twilio echoes it back while the call
// is alive. If no echo arrives within MARK_ECHO_TIMEOUT_MS the call is dead
// (caller hung up without Twilio sending stop/closed events).
const MARK_INTERVAL_MS      = 10_000;
const MARK_ECHO_TIMEOUT_MS  = 10_000;

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

    let streamSid   = null;
    let callSid     = null;
    let frameCount  = 0;
    let ttsCount    = 0;
    let lastMsgAt   = Date.now();
    let msgIndex    = 0;
    let activePacer = null;
    let isClosed    = false;

    let inactivityTimer  = null;
    let markTimer        = null;
    let ttsTimer         = null;

    // Mark echo tracking — detect dead calls
    // pendingMarks: Map<markName, timeoutHandle>
    const pendingMarks = new Map();

    // ── Serialized socket writes ───────────────────────────────────────────────────
    let writeQueue = Promise.resolve();
    const safeSend = (data) => {
      if (isClosed || socket.readyState !== 1) return;
      writeQueue = writeQueue
        .then(() => new Promise((resolve, reject) => {
          if (socket.readyState !== 1) return resolve();
          socket.send(data, (err) => (err ? reject(err) : resolve()));
        }))
        .catch((err) => {
          if (!isClosed) fastify.log.error(`[WS] safeSend error: ${err.message}`);
        });
      return writeQueue;
    };

    const resetInactivityTimer = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fastify.log.warn(
          `[WS] No inbound frame for ${INACTIVITY_MS / 1000}s — streamSid=${streamSid} ` +
          `(normal during TTS playback, potential issue if no TTS active)`
        );
      }, INACTIVITY_MS);
    };

    // ── Mark heartbeat + dead-call detection ──────────────────────────────────
    // How it works:
    //  1. We send a mark with a unique name every MARK_INTERVAL_MS
    //  2. We set a MARK_ECHO_TIMEOUT_MS timer expecting Twilio's echo
    //  3. When Twilio echoes the mark back we cancel the timeout
    //  4. If timeout fires before echo → call is dead → terminate socket
    const sendMark = () => {
      if (!streamSid || isClosed) return;

      const markName  = `hb-${Date.now()}`;
      const mediaMsg  = JSON.stringify({ event: 'mark', streamSid, mark: { name: markName } });
      safeSend(mediaMsg);

      // Expect echo within MARK_ECHO_TIMEOUT_MS
      const echoTimeout = setTimeout(() => {
        if (isClosed) return;
        fastify.log.warn(
          `[WS] Mark echo timeout — call likely dead. streamSid=${streamSid} mark=${markName}`
        );
        // Use terminate() not close() — bypasses 30s ws close timeout
        stopAll();
        try { socket.terminate(); } catch (_) {}
      }, MARK_ECHO_TIMEOUT_MS);

      pendingMarks.set(markName, echoTimeout);
    };

    const onMarkEcho = (markName) => {
      // Cancel the echo timeout for this mark — call is alive
      const t = pendingMarks.get(markName);
      if (t) { clearTimeout(t); pendingMarks.delete(markName); }
    };

    const startHeartbeat = () => {
      stopHeartbeat();
      markTimer = setInterval(sendMark, MARK_INTERVAL_MS);
      sendMark(); // immediate probe on stream start
    };

    const stopHeartbeat = () => {
      if (markTimer) { clearInterval(markTimer); markTimer = null; }
      // Clear all pending mark echo timeouts
      for (const t of pendingMarks.values()) clearTimeout(t);
      pendingMarks.clear();
    };

    // ── Master cleanup ─────────────────────────────────────────────────────────
    const stopAll = () => {
      if (isClosed) return;
      isClosed = true;
      clearTimeout(inactivityTimer);
      stopHeartbeat();
      if (ttsTimer)    { clearInterval(ttsTimer);  ttsTimer    = null; }
      if (activePacer) { activePacer.stop();        activePacer = null; }
    };

    // ── Azure TTS → ChunkStream(160) → FramePacer(20ms) → Twilio ──────────────
    const speakText = async (text) => {
      if (isClosed || !streamSid || socket.readyState !== 1) return;

      if (activePacer) { activePacer.stop(); activePacer = null; }

      try {
        fastify.log.info(`[TTS] Speaking (${text.length} chars): "${text.substring(0, 60)}"`);

        const azureStream = await tts.getStream(text, { emotion: 'cheerful' });

        if (isClosed || socket.readyState !== 1) { azureStream.destroy(); return; }

        const chunker = new ChunkStream(160);
        const pacer   = new FramePacer({ streamSid, safeSend, log: fastify.log, socket });
        activePacer   = pacer;

        azureStream.pipe(chunker);

        await new Promise((resolve, reject) => {
          chunker.on('data',  (frame) => pacer.push(frame));
          chunker.on('end',   () => { pacer.flush(); resolve(); });
          chunker.on('error', reject);
          azureStream.on('error', reject);
        });

        ttsCount++;
        const totalFrames = pacer.pending + pacer.sent;
        fastify.log.info(
          `[TTS] Buffered msg #${ttsCount} — frames=${totalFrames} ` +
          `playDuration=${(totalFrames * 20 / 1000).toFixed(1)}s streamSid=${streamSid}`
        );

      } catch (err) {
        if (err.name !== 'AbortError') fastify.log.error(`[TTS] speakText error: ${err.message}`);
      }
    };

    const startTtsInterval = () => {
      if (ttsTimer) { clearInterval(ttsTimer); ttsTimer = null; }
      speakText('Hello! I will send you a message every ten seconds.');
      ttsTimer = setInterval(async () => {
        if (isClosed) return;
        const text = RANDOM_MESSAGES[msgIndex % RANDOM_MESSAGES.length];
        msgIndex++;
        await speakText(text);
      }, TTS_INTERVAL_MS);
    };

    // ── Message handler ─────────────────────────────────────────────────────────
    socket.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        switch (msg.event) {

          case 'connected':
            fastify.log.info(`[WS] connected protocol=${msg.protocol}`);
            lastMsgAt = Date.now(); resetInactivityTimer();
            break;

          case 'start':
            streamSid = msg.start.streamSid;
            callSid   = msg.start.callSid;
            fastify.log.info(
              `[WS] stream started streamSid=${streamSid} callSid=${callSid} ` +
              `tracks=${JSON.stringify(msg.start.tracks)}`
            );
            lastMsgAt = Date.now(); resetInactivityTimer();
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
              lastMsgAt = Date.now(); resetInactivityTimer();
              if (frameCount % 100 === 0) {
                fastify.log.debug(
                  `[WS] inbound frames=${frameCount} tts=${ttsCount} pool=${JSON.stringify(workerPool.getStats())}`
                );
              }
            } catch (err) {
              fastify.log.error(`[WS] decode error streamSid=${streamSid}: ${err.message}`);
            }
            break;
          }

          case 'mark':
            fastify.log.debug(`[WS] mark echo name=${msg.mark?.name}`);
            // Cancel the dead-call timeout for this mark
            onMarkEcho(msg.mark?.name);
            lastMsgAt = Date.now(); resetInactivityTimer();
            break;

          case 'stop':
            fastify.log.info(`[WS] stream stopped streamSid=${streamSid} frames=${frameCount} tts=${ttsCount}`);
            stopAll();
            clearTwilioAudio({ safeSend, streamSid });
            break;

          case 'closed':
            fastify.log.info(`[WS] Twilio closed streamSid=${streamSid}`);
            stopAll();
            break;

          default:
            fastify.log.debug(`[WS] unhandled event=${msg.event}`);
            lastMsgAt = Date.now(); resetInactivityTimer();
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
      stopAll();
      streamSid = null; callSid = null; frameCount = 0; ttsCount = 0;
    });

    socket.on('error', (err) => {
      if (!isClosed) fastify.log.error(`[WS] socket error [${clientInfo}]: ${err.message}`);
    });
    socket.on('ping', () => fastify.log.debug(`[WS] ping from ${clientInfo}`));
    socket.on('pong', () => fastify.log.debug(`[WS] pong from ${clientInfo}`));
  });
}

module.exports = mediaStreamRoute;
