// src/pool/workerPool.js
// Singleton worker-thread pool for non-blocking µ-law → PCM decoding
'use strict';

const { Worker } = require('worker_threads');
const path       = require('path');
const os         = require('os');

class WorkerPool {
  constructor(size = os.cpus().length) {
    this.size         = size;
    this.workers      = [];
    this.queue        = [];           // pending { msg, taskId }
    this.pendingTasks = new Map();    // taskId → { resolve, reject }
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
        msg.err
          ? (this.stats.errors++,   pending.reject(new Error(msg.err)))
          : (this.stats.completed++, pending.resolve(msg.pcm));
      } else {
        // Should never happen – log if it does
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
        this._spawnWorker(id); // replace with fresh worker
      }
    });

    this.workers.push(worker);
  }

  /**
   * Submit a decode task.
   * Returns a Promise that resolves with the PCM Buffer.
   */
  execute(msg) {
    this.stats.queued++;

    return new Promise((resolve, reject) => {
      const taskId = `${msg.streamSid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      // Guard against hung workers
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

  /** Dispatch queued tasks to free workers. */
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

// Singleton – shared across the entire process
const workerPool = new WorkerPool();

module.exports = { WorkerPool, workerPool };
