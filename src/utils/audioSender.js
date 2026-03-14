// src/utils/audioSender.js
// Encodes PCM audio back to µ-law and sends it to Twilio as an outbound media message.
//
// Twilio outbound media message (from official docs):
// {
//   event:     'media',
//   streamSid: '<SID>',
//   media: {
//     payload: '<base64 mulaw/8000>'   ← raw bytes, NO file headers
//   }
// }
//
// REQUIREMENTS:
//  - <Connect><Stream> TwiML (bidirectional) — NOT <Start><Stream>
//  - encode() input MUST be Int16Array — NOT a Buffer
//  - Output must be raw mulaw bytes — no WAV/MP3 headers
'use strict';

const alawmulaw = require('alawmulaw');

/**
 * Send PCM audio back to Twilio as outbound µ-law audio.
 *
 * @param {object}   opts
 * @param {WebSocket} opts.socket     - live WS connection
 * @param {string}    opts.streamSid  - Twilio stream SID
 * @param {Int16Array} opts.int16     - decoded PCM as Int16Array (preferred)
 * @param {Buffer}    [opts.pcmBuf]   - fallback: raw PCM Buffer (converted internally)
 * @param {Function}  opts.safeSend   - serialized send fn
 * @param {object}    opts.log        - fastify logger
 */
function sendAudioToTwilio({ socket, streamSid, int16, pcmBuf, safeSend, log }) {
  try {
    if (!streamSid) {
      log.warn('[AUDIO] Cannot send — streamSid not set yet');
      return;
    }

    if (socket.readyState !== 1) {
      log.warn(`[AUDIO] Socket not OPEN (readyState=${socket.readyState}), dropping`);
      return;
    }

    // Resolve input: prefer Int16Array, fall back to converting Buffer
    // CRITICAL: alawmulaw.mulaw.encode() requires Int16Array NOT Buffer
    let samples;
    if (int16 instanceof Int16Array) {
      samples = int16;
    } else if (Buffer.isBuffer(pcmBuf) && pcmBuf.length > 0) {
      // Convert raw PCM Buffer → Int16Array
      // Each PCM sample is 2 bytes (16-bit), little-endian
      samples = new Int16Array(
        pcmBuf.buffer,
        pcmBuf.byteOffset,
        pcmBuf.byteLength / 2
      );
    } else {
      log.warn('[AUDIO] No valid audio data (need Int16Array or PCM Buffer)');
      return;
    }

    if (samples.length === 0) {
      log.warn('[AUDIO] Empty samples, skipping');
      return;
    }

    // Step 1: PCM Int16Array → µ-law Uint8Array
    // encode() returns Uint8Array — raw mulaw bytes, no headers
    const mulawBytes = alawmulaw.mulaw.encode(samples);

    // Step 2: Uint8Array → base64 string
    const payload = Buffer.from(mulawBytes).toString('base64');

    // Step 3: Twilio outbound media message (exact format from docs)
    const mediaMsg = JSON.stringify({
      event:     'media',
      streamSid,
      media: { payload }   // NO track, NO chunk, NO timestamp — just payload
    });

    // Step 4: Enqueue via serialized write queue
    safeSend(mediaMsg);

  } catch (err) {
    log.error(`[AUDIO] sendAudioToTwilio failed: ${err.message}`);
  }
}

/**
 * Send a 'clear' event to flush Twilio's outbound audio buffer.
 * Use for barge-in / interruption.
 */
function clearTwilioAudio({ safeSend, streamSid }) {
  safeSend(JSON.stringify({ event: 'clear', streamSid }));
}

module.exports = { sendAudioToTwilio, clearTwilioAudio };
