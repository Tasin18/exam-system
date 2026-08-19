/** Thin fetch wrapper: JSON in, JSON out, server error messages surfaced. */
(function (global) {
  'use strict';

  /**
   * How long to wait before giving up on a request.
   *
   * On a LAN, a request that had not answered in a second was never going to.
   * Over the internet the same request may legitimately take many seconds on a
   * weak mobile signal, and a browser left to its own devices will hang on a
   * dead connection for minutes — long enough for a student to lose their exam
   * time staring at a spinner. So: patient, but bounded.
   *
   * Uploads scale with their payload, because an admin saving a quiz full of
   * question images is sending megabytes over the same link.
   */
  var TIMEOUT_MS = 25000;
  var UPLOAD_MS_PER_KB = 12;
  var MAX_TIMEOUT_MS = 300000;

  function timeoutFor(bodyText, override) {
    if (override) return override;
    if (!bodyText || bodyText.length < 64 * 1024) return TIMEOUT_MS;
    return Math.min(MAX_TIMEOUT_MS, TIMEOUT_MS + (bodyText.length / 1024) * UPLOAD_MS_PER_KB);
  }

  function offlineError() {
    var err = new Error(navigator.onLine === false
      ? 'You appear to be offline. Reconnect to Wi-Fi or mobile data — your answers '
        + 'are saved and the exam will carry on.'
      : 'Cannot reach the exam server. Check your internet connection and try again.');
    err.status = 0;
    err.offline = true;
    return err;
  }

  function once(method, url, body, token, opts) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var o = { method: method, headers: {}, cache: 'no-store' };
    if (controller) o.signal = controller.signal;
    if (body !== undefined && body !== null) {
      o.headers['Content-Type'] = 'application/json';
      o.body = JSON.stringify(body);
    }
    if (token) o.headers['Authorization'] = 'Bearer ' + token;

    var timer = controller
      ? setTimeout(function () { controller.abort(); }, timeoutFor(o.body, opts.timeoutMs))
      : null;
    var done = function () { if (timer) clearTimeout(timer); };

    return fetch(url, o).then(function (res) {
      done();
      var isJson = (res.headers.get('content-type') || '').indexOf('application/json') !== -1;
      return (isJson ? res.json() : res.text().then(function (t) { return { error: t }; }))
        .catch(function () { return {}; })
        .then(function (data) {
          if (!res.ok) {
            var err = new Error(data.error || ('Request failed (' + res.status + ')'));
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        });
    }, function () {
      done();
      throw offlineError();
    });
  }

  /**
   * One automatic retry, for GET only.
   *
   * A dropped packet on a mobile handover is routine and a student should never
   * see it. Writes are deliberately excluded: this layer cannot tell "the
   * request never arrived" from "it arrived and the reply was lost", and a
   * retried POST would create a second quiz or a second attempt. The callers
   * that need a write to survive a dying connection have their own recovery —
   * the exam page re-flags progress as unsaved and falls back to sendBeacon.
   */
  function request(method, url, body, token, opts) {
    opts = opts || {};
    var attempt = once(method, url, body, token, opts);
    if (method !== 'GET' || opts.retry === false) return attempt;

    return attempt.catch(function (err) {
      if (!err.offline) throw err;
      return new Promise(function (resolve) { setTimeout(resolve, 800); })
        .then(function () { return once(method, url, body, token, opts); });
    });
  }

  global.api = {
    get: function (url, token, opts) { return request('GET', url, null, token, opts); },
    post: function (url, body, token, opts) { return request('POST', url, body || {}, token, opts); },
    put: function (url, body, token, opts) { return request('PUT', url, body || {}, token, opts); },
    del: function (url, token, opts) { return request('DELETE', url, null, token, opts); },
  };

  global.esc = function (value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  global.fmtTime = function (iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
})(window);
