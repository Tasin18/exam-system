/** Student exam portal: rendering, timing, autosave, and lockdown wiring. */
(function () {
  'use strict';

  var el = {
    title: document.getElementById('examTitle'),
    who: document.getElementById('examWho'),
    timer: document.getElementById('timer'),
    conn: document.getElementById('conn'),
    connText: document.getElementById('connText'),
    questions: document.getElementById('questions'),
    submitBar: document.getElementById('submitBar'),
    answeredCount: document.getElementById('answeredCount'),
    finalSubmit: document.getElementById('finalSubmit'),
    progressFill: document.getElementById('progressFill'),
    toast: document.getElementById('toast'),
    gate: document.getElementById('gate'),
    gateTitle: document.getElementById('gateTitle'),
    gateText: document.getElementById('gateText'),
    gateRules: document.getElementById('gateRules'),
    gateStart: document.getElementById('gateStart'),
    gateBack: document.getElementById('gateBack'),
    result: document.getElementById('result'),
    resultIcon: document.getElementById('resultIcon'),
    resultTitle: document.getElementById('resultTitle'),
    resultText: document.getElementById('resultText'),
    resultPending: document.getElementById('resultPending'),
    resultStamp: document.getElementById('resultStamp'),
    resultReason: document.getElementById('resultReason'),
  };

  var session = null;
  try { session = JSON.parse(sessionStorage.getItem('exam.session')); } catch (err) { session = null; }
  if (!session || !session.token) {
    window.location.replace('/');
    return;
  }

  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
  var state = {
    exam: null,
    answers: {},
    clockOffset: 0,      // serverNow - clientNow
    endsAt: 0,
    started: false,
    closed: false,
    dirty: false,
  };

  var socket = null;
  var lockdown = null;
  var tickHandle = null;
  var saveHandle = null;
  var toastHandle = null;

  /* ---------------- UI helpers ---------------- */

  function toast(message, kind) {
    el.toast.textContent = message;
    el.toast.className = 'toast' + (kind ? ' ' + kind : '');
    el.toast.hidden = false;
    clearTimeout(toastHandle);
    toastHandle = setTimeout(function () { el.toast.hidden = true; }, 4000);
  }

  function gateMessage(title, text, opts) {
    opts = opts || {};
    el.gate.hidden = false;
    el.gateTitle.textContent = title;
    el.gateText.textContent = text;
    el.gateRules.hidden = !opts.rules;
    el.gateStart.hidden = !opts.start;
    el.gateBack.style.display = opts.back ? 'block' : 'none';
  }

  /* ---------------- Load ---------------- */

  api.get('/api/quiz/exam', session.token).then(function (data) {
    state.exam = data;
    state.answers = data.savedAnswers || {};
    state.clockOffset = Date.parse(data.serverTime) - Date.now();
    state.endsAt = Date.parse(data.endsAt);

    el.title.textContent = data.quiz.title;
    el.who.textContent = data.student.name + ' · ' + data.student.studentId;
    document.title = data.quiz.title;

    renderQuestions(data.questions);
    updateAnsweredCount();

    var resumed = session.resumed && Object.keys(state.answers).length > 0;
    gateMessage(
      resumed ? 'Resume your exam' : 'Ready to begin',
      resumed
        ? 'Your previous answers were saved. Your original time limit still applies.'
        : data.questions.length + ' questions · '
          + Math.max(0, Math.round((state.endsAt - serverNow()) / 60000)) + ' minutes remaining.',
      { rules: true, start: true },
    );
  }).catch(function (err) {
    sessionStorage.removeItem('exam.session');
    gateMessage('Cannot start this exam', err.message, { back: true });
  });

  function serverNow() { return Date.now() + state.clockOffset; }

  /* ---------------- Rendering ---------------- */

  function renderQuestions(questions) {
    var frag = document.createDocumentFragment();

    questions.forEach(function (question, index) {
      var card = document.createElement('section');
      card.className = 'q-card';

      var idx = document.createElement('div');
      idx.className = 'q-index';
      idx.textContent = 'Question ' + (index + 1) + ' of ' + questions.length;
      card.appendChild(idx);

      var text = document.createElement('div');
      text.className = 'q-text';
      text.textContent = question.question_text;
      card.appendChild(text);

      if (question.has_image) {
        var figure = document.createElement('div');
        figure.className = 'q-figure';
        var img = document.createElement('img');
        // The token rides in the query string: an <img> cannot send a header.
        img.src = '/api/quiz/image/' + question.question_id
          + '?t=' + encodeURIComponent(session.token);
        img.alt = 'Figure for question ' + (index + 1);
        img.loading = 'lazy';
        // Decode off the main thread: a large image decoded synchronously
        // freezes scrolling on a phone for a noticeable beat.
        img.decoding = 'async';
        img.draggable = false;
        img.addEventListener('error', function () {
          figure.classList.add('failed');
          figure.textContent = 'Image could not be loaded. Tell your invigilator.';
        });
        figure.appendChild(img);
        card.appendChild(figure);
      }

      var key = 'q' + question.question_id;
      var group = 'group-' + question.question_id;

      question.options.forEach(function (option, optIndex) {
        var label = document.createElement('label');
        label.className = 'opt';

        var input = document.createElement('input');
        input.type = 'radio';
        input.name = group;
        input.value = String(optIndex);
        if (state.answers[key] === optIndex) {
          input.checked = true;
          label.classList.add('selected');
        }

        input.addEventListener('change', function () {
          state.answers[key] = optIndex;
          state.dirty = true;
          Array.prototype.forEach.call(card.querySelectorAll('.opt'), function (node) {
            node.classList.remove('selected');
          });
          label.classList.add('selected');
          updateAnsweredCount();
        });

        var keyEl = document.createElement('span');
        keyEl.className = 'opt-key';
        keyEl.textContent = (LETTERS[optIndex] || optIndex + 1) + '.';

        var textEl = document.createElement('span');
        textEl.className = 'opt-text';
        textEl.textContent = option;

        label.appendChild(input);
        label.appendChild(keyEl);
        label.appendChild(textEl);
        card.appendChild(label);
      });

      frag.appendChild(card);
    });

    el.questions.innerHTML = '';
    el.questions.appendChild(frag);
  }

  function updateAnsweredCount() {
    var total = state.exam ? state.exam.questions.length : 0;
    var answered = Object.keys(state.answers).length;
    el.answeredCount.textContent = answered + ' of ' + total + ' answered';
    el.progressFill.style.width = total ? (answered / total * 100) + '%' : '0%';
  }

  /* ---------------- Timer ---------------- */

  // Remembering what is already on screen keeps the tick from touching the DOM
  // 120 times a minute. Writing textContent/className forces a style recalc on
  // every frame budget, which is exactly the kind of drip that makes a
  // mid-range phone feel sluggish while scrolling.
  var lastClock = '';
  var lastTimerClass = '';

  function renderTimer() {
    var remaining = Math.max(0, state.endsAt - serverNow());
    var totalSeconds = Math.floor(remaining / 1000);
    var minutes = Math.floor(totalSeconds / 60);
    var seconds = totalSeconds % 60;

    var clock = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    if (clock !== lastClock) {
      lastClock = clock;
      el.timer.firstChild.nodeValue = clock;
    }

    var cls = 'timer'
      + (totalSeconds <= 30 ? ' critical' : totalSeconds <= 120 ? ' low' : '');
    if (cls !== lastTimerClass) {
      lastTimerClass = cls;
      el.timer.className = cls;
    }

    if (remaining <= 0 && !state.closed) {
      closeOut({ kind: 'expired' });
      flushProgress(true);
      submitExam('MANUAL', null, { silent: true });
    }
  }

  function startTimer() {
    // A text node to update in place, so the tick never rebuilds the element.
    el.timer.textContent = '--:--';
    renderTimer();
    // 1s, not 500ms: a seconds-resolution clock gains nothing from two ticks.
    tickHandle = setInterval(renderTimer, 1000);
  }

  /* ---------------- Autosave ---------------- */

  function flushProgress(force) {
    if (state.closed && !force) return;
    if (!state.dirty && !force) return;
    state.dirty = false;
    api.post('/api/quiz/progress', { answers: state.answers }, session.token)
      .catch(function () { state.dirty = true; });
  }

  /* ---------------- Socket ---------------- */

  function connectSocket() {
    socket = io({ transports: ['websocket', 'polling'], reconnectionDelayMax: 4000 });

    socket.on('connect', function () {
      el.conn.classList.remove('offline');
      el.connText.textContent = 'Connected';
      socket.emit('student:join', { token: session.token }, function (ack) {
        if (ack && !ack.ok) {
          el.connText.textContent = 'Session ended';
        }
      });
    });

    socket.on('disconnect', function () {
      el.conn.classList.add('offline');
      el.connText.textContent = 'Reconnecting…';
    });

    socket.on('heartbeat:ack', function (payload) {
      if (payload && payload.serverTime) {
        state.clockOffset = payload.serverTime - Date.now();
      }
    });

    socket.on('exam:expired', function (payload) {
      closeOut({ kind: 'expired', result: payload && payload.result });
    });

    socket.on('exam:terminated', function (payload) {
      closeOut({
        kind: 'terminated',
        reason: payload && payload.reason,
        result: payload && payload.result,
      });
    });

    socket.on('session:invalid', function (payload) {
      if (state.closed) return;
      closeOut({ kind: 'invalid', reason: payload && payload.reason });
    });

    // 20s rather than 8s. Socket.io already keeps the connection alive with its
    // own ping; this only refreshes the dashboard's "online" dot, so a slower
    // cadence means fewer radio wake-ups on 60 phones.
    setInterval(function () {
      if (socket && socket.connected && !state.closed) socket.emit('heartbeat');
    }, 20000);
  }

  /* ---------------- Submission ---------------- */

  function submitExam(type, reason, opts) {
    opts = opts || {};
    var payload = {
      token: session.token,
      answers: state.answers,
      submissionType: type,
      reason: reason || null,
    };
    var url = type === 'AUTO_TERMINATED' ? '/api/quiz/flag-submit' : '/api/quiz/submit';

    return api.post(url, payload, session.token).then(function (data) {
      if (!opts.silent) showResult(type, reason, data.result);
      else applyResult(data.result);
      return data.result;
    }).catch(function (err) {
      if (err.status === 403 || err.status === 401) {
        // Server already closed the attempt (timer sweep or a racing submit).
        if (!opts.silent) showResult(type, reason, null);
        return null;
      }
      // Last resort for a dying connection.
      beacon(url, payload);
      if (!opts.silent) showResult(type, reason, null);
      return null;
    });
  }

  /** Fire-and-forget submit that survives page teardown. */
  function beacon(url, payload) {
    if (!navigator.sendBeacon) return false;
    try {
      return navigator.sendBeacon(url, new Blob([JSON.stringify(payload)], {
        type: 'application/json',
      }));
    } catch (err) {
      return false;
    }
  }

  /**
   * Anti-cheat termination. Locks the screen first, then guarantees the server
   * hears about it: socket ack, HTTP fallback, sendBeacon as the last resort.
   */
  function terminate(reason) {
    if (state.closed) return;
    closeOut({ kind: 'terminated', reason: reason });

    var payload = {
      token: session.token,
      answers: state.answers,
      reason: reason,
      submissionType: 'AUTO_TERMINATED',
    };

    var settled = false;
    var viaHttp = function () {
      if (settled) return;
      settled = true;
      api.post('/api/quiz/flag-submit', payload, session.token)
        .then(function (data) { applyResult(data.result); })
        .catch(function () { beacon('/api/quiz/flag-submit', payload); });
    };

    if (socket && socket.connected) {
      var acked = false;
      socket.emit('flag_and_submit', {
        studentId: session.studentId, reason: reason, answers: state.answers,
      }, function (ack) {
        acked = true;
        if (ack && ack.ok) {
          settled = true;
          applyResult(ack.result);
        } else {
          viaHttp();
        }
      });
      setTimeout(function () { if (!acked) viaHttp(); }, 1500);
    } else {
      viaHttp();
    }
  }

  /** Stops the exam UI. Called before any network work so the screen locks instantly. */
  function closeOut(info) {
    if (state.closed) return;
    state.closed = true;
    clearInterval(tickHandle);
    clearInterval(saveHandle);
    if (lockdown) lockdown.finish();
    sessionStorage.removeItem('exam.session');
    el.submitBar.hidden = true;
    showResult(info.kind, info.reason, info.result);
  }

  function showResult(kind, reason, result) {
    el.gate.hidden = true;
    el.result.hidden = false;

    var showPending = true;

    if (kind === 'terminated') {
      el.resultIcon.textContent = '⚠';
      el.resultTitle.textContent = 'Exam terminated';
      el.resultText.textContent = 'Your exam was submitted automatically because exam policy '
        + 'was violated. Answers recorded up to that point have been saved.';
      el.resultReason.hidden = false;
      el.resultReason.textContent = 'Violation: ' + (reason || 'Policy violation');
    } else if (kind === 'expired') {
      el.resultIcon.textContent = '⏱';
      el.resultTitle.textContent = 'Time is up';
      el.resultText.textContent = 'Your exam was submitted automatically when the time limit '
        + 'was reached.';
    } else if (kind === 'invalid') {
      el.resultIcon.textContent = 'ℹ';
      el.resultTitle.textContent = 'Session ended';
      el.resultText.textContent = reason || 'This exam session is no longer valid.';
      showPending = false;
    } else {
      el.resultIcon.textContent = '✓';
      el.resultTitle.textContent = 'Exam submitted';
      el.resultText.textContent = 'Your answers have been recorded. Thank you.';
    }

    // Scores are released by the invigilator, never shown here.
    el.resultPending.hidden = !showPending;
    applyResult(result);
  }

  function applyResult(result) {
    if (!result) return;
    if (result.submittedAt) {
      el.resultStamp.hidden = false;
      el.resultStamp.textContent = 'Recorded at ' + fmtTime(result.submittedAt);
    }
  }

  /* ---------------- Start ---------------- */

  el.gateStart.addEventListener('click', function () {
    if (state.started || !state.exam) return;
    state.started = true;
    el.gateStart.disabled = true;
    el.gateStart.textContent = 'Starting…';

    lockdown = new Lockdown({
      onTerminate: terminate,
      onFlag: function (reason) {
        if (socket && socket.connected) socket.emit('flag', { reason: reason });
        else api.post('/api/quiz/flag', { token: session.token, reason: reason }, session.token)
          .catch(function () {});
      },
      onWarn: function (reason) {
        toast('Warning: ' + reason + '. This has been reported to your invigilator.', 'warn');
      },
    });

    // requestFullscreen must happen inside this click handler's gesture.
    lockdown.start().then(function (info) {
      el.gate.hidden = true;
      el.submitBar.hidden = false;
      startTimer();
      connectSocket();
      saveHandle = setInterval(function () { flushProgress(false); }, 10000);

      if (!info.fullscreen) {
        toast('Fullscreen was blocked by your browser. Do not switch away from this window.',
          'warn');
      }
    });
  });

  el.finalSubmit.addEventListener('click', function () {
    if (state.closed) return;
    var total = state.exam.questions.length;
    var answered = Object.keys(state.answers).length;
    var message = answered < total
      ? 'You have answered ' + answered + ' of ' + total + ' questions. '
        + 'Submit anyway? This cannot be undone.'
      : 'Submit your exam? This cannot be undone.';

    // confirm() blurs the window, so the lockdown is stood down first — this is
    // a legitimate submit, not a violation.
    if (lockdown) lockdown.finished = true;
    var go = window.confirm(message);
    if (!go) {
      if (lockdown) lockdown.finished = false;
      return;
    }

    el.finalSubmit.disabled = true;
    el.finalSubmit.textContent = 'Submitting…';
    closeOut({ kind: 'submitted' });
    submitExam('MANUAL', null, { silent: true });
  });

  // Best-effort save if the page is being torn down mid-exam.
  window.addEventListener('pagehide', function () {
    if (state.closed || !state.started) return;
    beacon('/api/quiz/progress', { token: session.token, answers: state.answers });
  });
})();
