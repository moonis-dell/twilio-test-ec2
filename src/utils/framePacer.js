// src/utils/framePacer.js
// Queues 160-byte mulaw frames and releases one every 20ms via setInterval.
// Prevents flooding Twilio with bursted frames from Azure TTS.
//
// Usage:
//   const pacer = new FramePacer({ streamSid, safeSend, log });
//   pacer.push(frame);   // called for each 160-byte chunk
//   pacer.flush();       // call after stream ends (drains remainder + stops timer)
//   pacer.stop();        // call on hangup / interrupt (discards queue)
'use strict';

const FRAME_MS    = 20;   // one frame every 20ms
const FRAME_BYTES = 160;  // 8kHz * 8bit * 20ms

class FramePacer {
  /**
   * @param {object}   opts
   * @param {string}   opts.streamSid  - Twilio stream SID
   * @param {Function} opts.safeSend   - serialized WS send fn
   * @param {object}   opts.log        - fastify logger
   */
  constructor({ streamSid, safeSend, log }) {
    this.streamSid = streamSid;
    this.safeSend  = safeSend;
    this.log       = log;

    this._queue    = [];      // Buffer[] of 160-byte frames waiting to be sent
    this._timer    = null;
    this._flushing = false;
    this._sent     = 0;
  }

  // Called for each 160-byte chunk produced by ChunkStream
  push(frame) {
    this._queue.push(frame);
    if (!this._timer) this._start();
  }

  // Called when Azure stream ends — drains remaining queue then auto-stops
  flush() {
    this._flushing = true;
    // If queue is already empty when flush() called, stop immediately
    if (this._queue.length === 0) this._stop();
  }

  // Discard everything — call on hangup or barge-in
  stop() {
    this._stop();
    this._queue = [];
    this._flushing = false;
  }

  // Total frames sent so far
  get sent() { return this._sent; }

  // Frames still waiting in queue
  get pending() { return this._queue.length; }

  _start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), FRAME_MS);
  }

  _stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _tick() {
    if (this._queue.length === 0) {
      // Queue drained
      if (this._flushing) {
        this.log.debug(
          `[PACER] Done — sent=${this._sent} streamSid=${this.streamSid}`
        );
        this._stop();
      }
      return;
    }

    const frame   = this._queue.shift();
    const payload = frame.toString('base64');

    this.safeSend(JSON.stringify({
      event:     'media',
      streamSid: this.streamSid,
      media:     { payload }
    }));

    this._sent++;

    if (this._sent % 50 === 0) {
      this.log.debug(
        `[PACER] sent=${this._sent} pending=${this._queue.length} streamSid=${this.streamSid}`
      );
    }
  }
}

module.exports = { FramePacer, FRAME_MS, FRAME_BYTES };
