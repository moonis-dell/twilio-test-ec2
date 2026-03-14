// src/utils/framePacer.js
// Queues 160-byte mulaw frames and releases one every 20ms via setInterval.
'use strict';

const FRAME_MS    = 20;   // one frame every 20ms
const FRAME_BYTES = 160;  // 8kHz * 8bit * 20ms

class FramePacer {
  /**
   * @param {object}    opts
   * @param {string}    opts.streamSid
   * @param {Function}  opts.safeSend
   * @param {object}    opts.log
   * @param {WebSocket} opts.socket     - checked each tick to auto-stop on close
   */
  constructor({ streamSid, safeSend, log, socket }) {
    this.streamSid = streamSid;
    this.safeSend  = safeSend;
    this.log       = log;
    this.socket    = socket;
    this._queue    = [];
    this._timer    = null;
    this._flushing = false;
    this._stopped  = false;
    this._sent     = 0;
  }

  push(frame) {
    if (this._stopped) return;
    this._queue.push(frame);
    if (!this._timer) this._start();
  }

  flush() {
    if (this._stopped) return;
    this._flushing = true;
    if (this._queue.length === 0) this._stop();
  }

  stop() {
    this._stopped = true;
    this._stop();
    this._queue = [];
  }

  get sent()    { return this._sent; }
  get pending() { return this._queue.length; }

  _start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), FRAME_MS);
  }

  _stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _tick() {
    // Auto-stop if socket closed mid-drain (e.g. SIGTERM, hangup)
    if (this.socket.readyState !== 1 /* WS.OPEN */) {
      this.log.debug(`[PACER] Socket not open, stopping pacer streamSid=${this.streamSid}`);
      this.stop();
      return;
    }

    if (this._queue.length === 0) {
      if (this._flushing) {
        this.log.debug(`[PACER] Queue drained — sent=${this._sent} streamSid=${this.streamSid}`);
        this._stop();
      }
      return;
    }

    const payload = this._queue.shift().toString('base64');
    this.safeSend(JSON.stringify({
      event: 'media', streamSid: this.streamSid, media: { payload }
    }));
    this._sent++;

    if (this._sent % 50 === 0) {
      this.log.debug(`[PACER] sent=${this._sent} pending=${this._queue.length} streamSid=${this.streamSid}`);
    }
  }
}

module.exports = { FramePacer, FRAME_MS, FRAME_BYTES };
