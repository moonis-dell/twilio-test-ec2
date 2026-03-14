// src/utils/audioSender.js
// Encodes PCM audio back to µ-law and sends it to Twilio as a media message.
//
// Twilio outbound media message format (from official docs):
// {
//   event:    'media',
//   streamSid: '<SID>',
//   media: {
//     payload: '<base64-encoded mulaw/8000>'   // ← NO track field
//   }
// }
//
// IMPORTANT:
//  - Only works with <Connect><Stream> TwiML (bidirectional)
//  - <Start><Stream> is unidirectional — outbound messages are silently ignored
//  - payload must be raw mulaw/8000 base64 — NO audio file headers (no WAV, no MP3)
'use strict';

const { encode } = require('alawmulaw');

/**
 * Encode a PCM Buffer to µ-law and send it to Twilio as outbound audio.
 *
 * @param {import('ws').WebSocket} socket    - live WS connection
 * @param {string}                 streamSid - Twilio stream SID
 * @param {Buffer}                 pcmBuf    - 16-bit signed linear PCM at 8kHz
 * @param {Function}               safeSend  - serialized send function
 * @param {object}                 log       - fastify logger
 */
function sendAudioToTwilio({ socket, streamSid, pcmBuf, safeSend, log }) {
  try {
    if (!streamSid) {
      log.warn('[AUDIO] Cannot send — streamSid not set yet');
      return;
    }

    if (!pcmBuf || pcmBuf.length === 0) {
      log.warn('[AUDIO] Empty PCM buffer, skipping');
      return;
    }

    if (socket.readyState !== 1) {
      log.warn(`[AUDIO] Socket not OPEN (readyState=${socket.readyState}), dropping`);
      return;
    }

    // Step 1: PCM (16-bit signed linear, 8kHz) → µ-law
    const mulawBuf = encode(pcmBuf);

    // Step 2: µ-law Buffer → base64
    // NOTE: mulawBuf is raw audio bytes — no file headers, exactly what Twilio expects
    const payload = mulawBuf.toString('base64');

    // Step 3: Build outbound media message
    // Per Twilio docs: only event, streamSid, media.payload — NO track field
    const mediaMsg = JSON.stringify({
      event:     'media',
      streamSid,
      media: {
        payload   // raw mulaw/8000 base64 — no track, no chunk, no timestamp
      }
    });

    // Step 4: Send through serialized write queue
    safeSend(mediaMsg);

  } catch (err) {
    log.error(`[AUDIO] sendAudioToTwilio failed: ${err.message}`);
  }
}

/**
 * Send a 'clear' event to Twilio to flush buffered outbound audio.
 * Use this to interrupt currently playing audio (e.g., barge-in).
 *
 * @param {Function} safeSend
 * @param {string}   streamSid
 */
function clearTwilioAudio({ safeSend, streamSid }) {
  safeSend(JSON.stringify({
    event:     'clear',
    streamSid
  }));
}

module.exports = { sendAudioToTwilio, clearTwilioAudio };
