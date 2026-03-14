// src/pool/workerPool.js
'use strict';

const { Worker } = require('worker_threads');
const path       = require('path');
const os         = require('os');

class WorkerPool {
  constructor(size = os.cpus().length) {
    this.size         = size;
    this.workers      = [];
    this.queue        = [];
    this.pendingTasks = new Map();
    this.stats        = { queued: 0, completed: 0, errors: 0 };
    this._init();
  }

  _init() {
    for (let i = 0; i < this.size; i++) this._spawnWorker(i);
  }

  _spawnWorker(id) {
    const worker    = new Worker(path.resolve(__dirname, '../workers/workerDecode.js'));
    worker.workerId = id;
    worker.isBusy   = false;

    worker.on('message', (msg) => {
      worker.isBusy = false;

      const pending = this.pendingTasks.get(msg.taskId);
      if (pending) {
        this.pendingTasks.delete(msg.taskId);

        if (msg.err) {
          this.stats.errors++;
          pending.reject(new Error(msg.err));
        } else {
          this.stats.completed++;

          // Reconstruct Int16Array from the transferred ArrayBuffer
          // This is zero-copy — the ArrayBuffer was transferred, not cloned
          const int16  = new Int16Array(msg.pcmArrayBuffer);

          // Also expose as Buffer for any consumers that need Buffer API
          const pcmBuf = Buffer.from(msg.pcmArrayBuffer);

          pending.resolve({ int16, pcmBuf });
        }
      } else {
        console.error(`[POOL] Orphaned response taskId=${msg.taskId}`);
      }

      this._drain();
    });

    worker.on('error', (err) => {
      console.error(`[POOL] Worker ${id} error: ${err.message}`);
      worker.isBusy = false;
      this._drain();
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.warn(`[POOL] Worker ${id} exited (code ${code}), respawning…`);
        const idx = this.workers.indexOf(worker);
        if (idx >= 0) this.workers.splice(idx, 1);
        this._spawnWorker(id);
      }
    });

    this.workers.push(worker);
  }

  execute(msg) {
    this.stats.queued++;
    return new Promise((resolve, reject) => {
      const taskId = `${msg.streamSid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const timer = setTimeout(() => {
        this.pendingTasks.delete(taskId);
        this.stats.errors++;
        reject(new Error(`Worker timeout – queue depth: ${this.queue.length}`));
      }, 5_000);

      this.pendingTasks.set(taskId, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject:  (err)    => { clearTimeout(timer); reject(err);    }
      });

      this.queue.push({ msg: { ...msg, taskId }, taskId });
      this._drain();
    });
  }

  _drain() {
    while (this.queue.length > 0) {
      const free = this.workers.find(w => !w.isBusy);
      if (!free) break;
      const { msg } = this.queue.shift();
      free.isBusy = true;
      free.postMessage(msg);
    }
  }

  getStats() {
    return {
      ...this.stats,
      queueDepth:   this.queue.length,
      pendingTasks: this.pendingTasks.size,
      busyWorkers:  this.workers.filter(w => w.isBusy).length,
      totalWorkers: this.workers.length
    };
  }

  async terminateAll() {
    await Promise.all(this.workers.map(w => w.terminate()));
  }
}

const workerPool = new WorkerPool();
module.exports = { WorkerPool, workerPool };
