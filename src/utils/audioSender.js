// src/utils/audioSender.js
// Encodes PCM audio back to µ-law and sends it to Twilio as a media message.
// Twilio Media Stream protocol requires:
//   - event: 'media'
//   - payload: base64-encoded µ-law audio
//   - track: 'outbound'
'use strict';

const { encode } = require('alawmulaw');

/**
 * Encode a PCM Buffer to µ-law base64 and send it back to Twilio
 * via the open WebSocket.
 *
 * @param {import('ws').WebSocket} socket   - the live WS connection
 * @param {string}                 streamSid - Twilio stream SID
 * @param {Buffer}                 pcmBuf    - 16-bit signed linear PCM
 * @param {Function}               safeSend  - serialized send function
 * @param {object}                 log       - fastify logger instance
 */
function sendAudioToTwilio({ socket, streamSid, pcmBuf, safeSend, log }) {
  try {
    if (!streamSid) {
      log.warn('[AUDIO] Cannot send audio – streamSid not yet set');
      return;
    }

    if (!pcmBuf || pcmBuf.length === 0) {
      log.warn('[AUDIO] Empty PCM buffer, skipping send');
      return;
    }

    if (socket.readyState !== 1) { // 1 = WebSocket.OPEN
      log.warn(`[AUDIO] Socket not OPEN (state=${socket.readyState}), dropping audio`);
      return;
    }

    // Step 1: PCM (16-bit signed linear) → µ-law
    const mulawBuf = encode(pcmBuf);

    // Step 2: µ-law → base64 string
    const payload = mulawBuf.toString('base64');

    // Step 3: Wrap in Twilio media message
    // Twilio expects outbound audio on the 'outbound' track.
    // The 'media' event with track='outbound' plays audio to the caller.
    const mediaMsg = JSON.stringify({
      event:     'media',
      streamSid,
      media: {
        track:   'outbound',
        payload
      }
    });

    // Step 4: Send via serialized queue (no concurrent write race)
    safeSend(mediaMsg);
  } catch (err) {
    log.error(`[AUDIO] Failed to send audio to Twilio: ${err.message}`);
  }
}

/**
 * Send a 'clear' message to Twilio to stop any currently playing audio.
 * Useful when you want to interrupt an ongoing TTS/audio playback.
 *
 * @param {Function} safeSend  - serialized send function
 * @param {string}   streamSid - Twilio stream SID
 */
function clearTwilioAudio({ safeSend, streamSid }) {
  safeSend(JSON.stringify({
    event:     'clear',
    streamSid
  }));
}

module.exports = { sendAudioToTwilio, clearTwilioAudio };
