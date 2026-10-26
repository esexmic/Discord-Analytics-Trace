'use strict';

const { EventEmitter } = require('events');
const db = require('./db');

/**
 * Buffer de escritura. Los eventos llegan de a uno desde el gateway de Discord;
 * agruparlos en lotes de 40 / 700ms evita un round-trip a Supabase por mensaje.
 *
 * Si una escritura falla, el lote vuelve al frente de la cola y se reintenta a
 * los 3s, hasta 5 veces. Después se descarta: es preferible perder un lote a
 * quedar reintentando para siempre contra una tabla que no existe.
 *
 * La cola tiene techo (5000): si la DB está caída mucho tiempo, se descartan
 * los más viejos antes que comerse la RAM del proceso.
 */
class EventQueue extends EventEmitter {
  constructor({
    flushMs = 700,
    retryMs = 3000,
    maxBatch = 40,
    maxSize = 5000,
    maxAttempts = 5,
  } = {}) {
    super();
    this.flushMs = flushMs;
    this.retryMs = retryMs;
    this.maxBatch = maxBatch;
    this.maxSize = maxSize;
    this.maxAttempts = maxAttempts;
    this.pending = [];
    this.timer = null;
    this.flushing = false;
    this.droppedCount = 0;
    this.attempts = 0;
    this.nextFlushMs = flushMs;
  }

  get size() {
    return this.pending.length;
  }

  get dropped() {
    return this.droppedCount;
  }

  push(event) {
    if (this.pending.length >= this.maxSize) {
      this.pending.shift();
      this.droppedCount += 1;
    }
    this.pending.push(event);
    this.schedule(this.pending.length >= this.maxBatch ? 0 : this.flushMs);
  }

  schedule(ms) {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(0, ms));
    this.timer.unref?.();
  }

  clearTimer() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  async flush() {
    if (this.flushing || !this.pending.length) return;
    this.clearTimer();

    this.flushing = true;
    const batch = this.pending.splice(0, this.maxBatch);

    try {
      const rows = await db.insertEvents(batch);
      if (rows.length) this.emit('events', rows);
      this.attempts = 0;
      this.nextFlushMs = 50;
    } catch (error) {
      this.attempts += 1;

      if (this.attempts >= this.maxAttempts) {
        this.droppedCount += batch.length;
        this.attempts = 0;
        this.nextFlushMs = 50;
        console.error(
          `[queue] insert falló ${this.maxAttempts} veces seguidas, se descartan ${batch.length} eventos:`,
          error.message
        );
      } else {
        console.error('[queue] insert falló, reintento en 3s:', error.message);
        this.pending.unshift(...batch);
        if (this.pending.length > this.maxSize) {
          const overflow = this.pending.length - this.maxSize;
          this.droppedCount += overflow;
          this.pending.splice(this.maxSize, overflow);
        }
        this.nextFlushMs = this.retryMs;
      }
    } finally {
      this.flushing = false;
      if (this.pending.length) this.schedule(this.nextFlushMs);
    }
  }

  /**
   * Vacía la cola con un deadline (shutdown). Devuelve cuántos eventos quedaron
   * sin escribir.
   */
  async drain(deadlineMs = 4000) {
    this.nextFlushMs = 0;
    const until = Date.now() + deadlineMs;
    while (this.pending.length && Date.now() < until) {
      await this.flush();
      if (this.pending.length) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return this.pending.length;
  }
}

module.exports = new EventQueue();
