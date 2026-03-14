// src/utils/chunkStream.js
// Transform stream that slices arbitrary-sized Buffer chunks into
// exact N-byte frames. Used to pace Azure TTS output into
// 160-byte / 20ms mulaw frames that Twilio expects.
'use strict';

const { Transform } = require('stream');

class ChunkStream extends Transform {
  /**
   * @param {number} frameSize - bytes per output chunk (default 160)
   */
  constructor(frameSize = 160) {
    super();
    this.frameSize = frameSize;
    this._buf      = Buffer.alloc(0);  // internal accumulator
  }

  _transform(chunk, _encoding, callback) {
    // Append incoming bytes to accumulator
    this._buf = Buffer.concat([this._buf, chunk]);

    // Push out as many complete frames as possible
    while (this._buf.length >= this.frameSize) {
      this.push(this._buf.slice(0, this.frameSize));
      this._buf = this._buf.slice(this.frameSize);
    }

    callback();
  }

  _flush(callback) {
    // Push any remaining bytes as a final (possibly smaller) frame
    if (this._buf.length > 0) {
      this.push(this._buf);
      this._buf = Buffer.alloc(0);
    }
    callback();
  }
}

module.exports = { ChunkStream };
