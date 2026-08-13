/** Thin fetch wrapper: JSON in, JSON out, server error messages surfaced. */
(function (global) {
  'use strict';

  function request(method, url, body, token) {
    var opts = { method: method, headers: {}, cache: 'no-store' };
    if (body !== undefined && body !== null) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;

    return fetch(url, opts).then(function (res) {
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
      var err = new Error('Cannot reach the exam server. Check your Wi-Fi connection.');
      err.status = 0;
      throw err;
    });
  }

  global.api = {
    get: function (url, token) { return request('GET', url, null, token); },
    post: function (url, body, token) { return request('POST', url, body || {}, token); },
    put: function (url, body, token) { return request('PUT', url, body || {}, token); },
    del: function (url, token) { return request('DELETE', url, null, token); },
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
