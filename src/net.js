'use strict';

/**
 * fetch con deadline y reintentos cortos para las salidas del server (Supabase,
 * Discord). En hosting (Railway) el DNS puede fallar de forma intermitente y el
 * fetch nativo devuelve un `TypeError: fetch failed` sin causa visible; acá se
 * reintenta el handshake y se describe el código real (ENOTFOUND, EAI_AGAIN,
 * ECONNRESET, timeout) para que el panel muestre algo accionable.
 *
 * Reintentos: un GET/HEAD se puede repetir siempre. Los POST/PATCH/DELETE solo
 * cuando la conexión ni siquiera se estableció, para no duplicar escrituras.
 */

const CONNECT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

const AMBIGUOUS_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function causeCode(error) {
  let current = error;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (typeof current.code === 'string' && current.code) return current.code;
    current = current.cause;
  }
  return '';
}

function causeMessage(error) {
  let current = error?.cause;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current.message && current.message !== error.message) return current.message;
    current = current.cause;
  }
  return '';
}

/** Texto corto y estable para logs y para la UI. */
function describe(error) {
  if (!error) return 'error de red desconocido';
  const code = causeCode(error);
  const detail = causeMessage(error);
  const base = error.name === 'TimeoutError' || code === 'ABORT_ERR'
    ? 'timeout de red'
    : `fetch failed${code ? ` (${code})` : ''}`;
  const message = error.message && error.message !== 'fetch failed' ? `: ${error.message}` : '';
  return `${base}${message}${detail && !String(error.message || '').includes(detail) ? ` · ${detail}` : ''}`;
}

function isTimeout(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || causeCode(error) === 'ABORT_ERR'
    || /timeout/i.test(String(error?.message || ''));
}

function shouldRetry(error, method, attempt, retries) {
  if (attempt >= retries) return false;
  const code = causeCode(error);
  const safe = SAFE_METHODS.has(method);
  if (isTimeout(error)) return safe;
  if (CONNECT_CODES.has(code)) return true;
  if (AMBIGUOUS_CODES.has(code)) return safe;
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function fetchWithRetry(input, init = {}, options = {}) {
  const {
    retries = 1,
    timeoutMs = 15_000,
    backoffMs = 400,
    label = 'fetch',
  } = options;
  const method = String(init.method || 'GET').toUpperCase();
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    timer.unref?.();

    try {
      const signal = init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal;
      return await fetch(input, { ...init, signal });
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error, method, attempt, retries)) break;
      const wait = backoffMs * (attempt + 1);
      console.warn(`[net] ${label} intento ${attempt + 1} falló (${describe(error)}), reintento en ${wait}ms`);
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw Object.assign(new Error(describe(lastError)), {
    code: 'network',
    cause: lastError,
  });
}

module.exports = { fetchWithRetry, describe, causeCode, isTimeout };
