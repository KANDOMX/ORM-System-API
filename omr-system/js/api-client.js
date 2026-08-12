/**
 * OMR MARKING SYSTEM — API CLIENT
 * -----------------------------------
 * Talks to the Apps Script Web App deployed from Code.gs.
 *
 * IMPORTANT: requests are sent with Content-Type: text/plain.
 * Apps Script Web Apps do not handle the CORS preflight (OPTIONS)
 * request that browsers send for "application/json" POSTs from a
 * different origin — the request silently fails. Sending as
 * text/plain avoids the preflight; Code.gs parses the JSON body
 * regardless of the declared content type, so nothing else changes.
 *
 * Failed calls are queued in localStorage and retried on demand
 * (call ApiClient.flushQueue()) or automatically when the browser
 * comes back online — the tablet's wifi is assumed to be unreliable.
 */

const ApiClient = (function () {
  const QUEUE_KEY = 'omr_pending_queue_v1';
  let API_BASE = '';

  function configure(url) { API_BASE = url; }

  function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch { return []; }
  }
  function saveQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }

  function enqueue(action, payload) {
    const q = getQueue();
    q.push({ action, payload, queuedAt: Date.now() });
    saveQueue(q);
  }

  /** Low-level call. Throws on network/HTTP failure. */
  async function callRaw(action, payload) {
    if (!API_BASE) throw new Error('ApiClient not configured — call ApiClient.configure(url) first');
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, payload })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  }

  /**
   * Main entry point. Tries immediately; on failure, queues for
   * later and returns { queued: true } instead of throwing —
   * callers decide how to surface that to the user.
   */
  async function call(action, payload, opts = {}) {
    try {
      return await callRaw(action, payload);
    } catch (err) {
      if (opts.noQueue) throw err;
      enqueue(action, payload);
      return { queued: true, error: err.message };
    }
  }

  /** Attempts to send every queued item; removes ones that succeed. */
  async function flushQueue(onProgress) {
    const q = getQueue();
    const remaining = [];
    let sent = 0;
    for (const item of q) {
      try {
        await callRaw(item.action, item.payload);
        sent++;
        if (onProgress) onProgress(sent, q.length);
      } catch {
        remaining.push(item);
      }
    }
    saveQueue(remaining);
    return { sent, remaining: remaining.length };
  }

  function queueLength() { return getQueue().length; }

  // Auto-flush when connectivity returns
  window.addEventListener('online', () => { flushQueue(); });

  return { configure, call, flushQueue, queueLength };
})();
