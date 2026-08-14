/** Admin console: quiz CRUD, live monitoring, overrides, results & export. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

  var token = sessionStorage.getItem('admin.token') || null;
  var socket = null;
  var state = {
    view: 'monitor',
    quizzes: [],
    monitorQuizId: null,
    resultsQuizId: null,
    snapshot: null,
    editing: null,       // quiz_id being edited, or null for a new quiz
    sheetStudentId: null, // student whose response sheet is open
    joinUrl: null,        // last known student join URL, to detect DHCP changes
    feed: [],
  };

  /* ================= Gate ================= */

  function showGate(message) {
    $('gate').hidden = false;
    $('shell').hidden = true;
    $('gateError').hidden = !message;
    if (message) $('gateError').textContent = message;
  }

  function enterShell() {
    $('gate').hidden = true;
    $('shell').hidden = false;
    connectSocket();
    loadQuizzes();
    loadNetwork();
  }

  $('gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api.post('/api/admin/login', { password: $('password').value }).then(function (data) {
      token = data.token;
      sessionStorage.setItem('admin.token', token);
      $('password').value = '';
      enterShell();
    }).catch(function (err) { showGate(err.message); });
  });

  $('logout').addEventListener('click', function () {
    sessionStorage.removeItem('admin.token');
    token = null;
    if (socket) socket.disconnect();
    showGate(null);
  });

  function guard(err) {
    if (err && err.status === 401) {
      sessionStorage.removeItem('admin.token');
      token = null;
      showGate('Session expired. Please sign in again.');
      return true;
    }
    $('globalError').hidden = false;
    $('globalError').textContent = err.message;
    setTimeout(function () { $('globalError').hidden = true; }, 6000);
    return false;
  }

  /* ================= Navigation ================= */

  Array.prototype.forEach.call(document.querySelectorAll('.top nav button'), function (btn) {
    btn.addEventListener('click', function () {
      state.view = btn.getAttribute('data-view');
      Array.prototype.forEach.call(document.querySelectorAll('.top nav button'), function (b) {
        b.classList.toggle('active', b === btn);
      });
      ['monitor', 'quizzes', 'results', 'network'].forEach(function (name) {
        $('view-' + name).hidden = name !== state.view;
      });
      if (state.view === 'results') loadResults();
    });
  });

  /* ================= Socket ================= */

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', function () {
      socket.emit('admin:join', { token: token, quizId: state.monitorQuizId }, function (ack) {
        if (ack && ack.ok) {
          $('liveDot').style.background = '#17795e';
          $('liveText').textContent = 'live';
        } else {
          $('liveText').textContent = 'unauthorized';
        }
      });
    });

    socket.on('disconnect', function () {
      $('liveDot').style.background = '#b3261e';
      $('liveText').textContent = 'reconnecting…';
    });

    socket.on('admin:snapshot', function (snapshot) {
      state.snapshot = snapshot;
      renderMonitor(snapshot);
    });

    socket.on('admin:flag', function (event) { pushFeed(event); });

    socket.on('admin:attempt', function (event) {
      if (event.status === 'TERMINATED') {
        pushFeed({
          studentId: event.studentId, quizId: event.quizId,
          reason: event.reason || 'Auto-terminated', severity: 'FATAL', at: event.at,
        });
      }
      if (state.view === 'results') loadResults();
    });
  }

  function watch(quizId) {
    state.monitorQuizId = quizId;
    if (socket && socket.connected) socket.emit('admin:watch', { quizId: quizId });
    refreshMonitor();
  }

  function refreshMonitor() {
    if (!state.monitorQuizId) return;
    api.get('/api/admin/monitor/' + state.monitorQuizId, token).then(function (snapshot) {
      state.snapshot = snapshot;
      state.feed = (snapshot.flags || []).slice();
      renderMonitor(snapshot);
      renderFeed();
    }).catch(guard);
  }

  /* ================= Live monitor ================= */

  function renderMonitor(snapshot) {
    if (!snapshot || Number(snapshot.quiz.quiz_id) !== Number(state.monitorQuizId)) return;

    $('monitorTitle').textContent = snapshot.quiz.title;
    $('monitorHint').textContent = snapshot.questionCount + ' questions · '
      + snapshot.quiz.duration_minutes + ' min · '
      + (snapshot.quiz.is_active ? 'ACTIVE — students can log in' : 'inactive');

    var toggle = $('toggleActive');
    toggle.textContent = snapshot.quiz.is_active ? 'Deactivate' : 'Activate';
    toggle.className = 'btn' + (snapshot.quiz.is_active ? ' danger' : '');

    $('statOnline').textContent = snapshot.onlineCount;
    $('statNotStarted').textContent = snapshot.counts.NOT_STARTED;
    $('statInProgress').textContent = snapshot.counts.IN_PROGRESS;
    $('statSubmitted').textContent = snapshot.counts.SUBMITTED;
    $('statTerminated').textContent = snapshot.counts.AUTO_TERMINATED;

    var rows = snapshot.students.map(function (s) {
      var canReset = s.display === 'SUBMITTED' || s.display === 'AUTO_TERMINATED';
      var actions = '';
      if (canReset) {
        actions = '<button class="btn small" data-act="reset" data-id="' + esc(s.studentId)
          + '">Grant retake</button>';
      } else if (s.display === 'IN_PROGRESS') {
        actions = '<button class="btn small danger" data-act="force" data-id="' + esc(s.studentId)
          + '">Force submit</button>';
      }
      return '<tr>'
        + '<td><strong>' + esc(s.studentId) + '</strong></td>'
        + '<td>' + esc(s.name) + '</td>'
        + '<td><span class="pill ' + s.display + '">' + s.display.replace(/_/g, ' ') + '</span></td>'
        + '<td><span class="pill ' + (s.online ? 'live' : 'off') + '">'
          + (s.online ? 'online' : 'offline') + '</span></td>'
        + '<td class="num">' + (s.total ? s.answered + '/' + s.total : '—') + '</td>'
        + '<td class="num">' + (s.display === 'NOT_STARTED' || s.display === 'IN_PROGRESS'
            ? '—' : s.score + '%') + '</td>'
        + '<td class="num">' + (s.violations || 0) + '</td>'
        + '<td>' + fmtTime(s.startTime) + '</td>'
        + '<td class="actions">' + actions + '</td>'
        + '</tr>';
    });

    $('monitorRows').innerHTML = rows.join('');
    $('monitorEmpty').hidden = rows.length > 0;
  }

  $('monitorRows').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var studentId = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');

    if (act === 'reset') {
      if (!confirm('Grant a retake to ' + studentId + '? Their recorded attempt and flags '
        + 'will be cleared and they can log in again.')) return;
      api.post('/api/admin/reset-attempt',
        { studentId: studentId, quizId: state.monitorQuizId }, token)
        .then(refreshMonitor).catch(guard);
    }

    if (act === 'force') {
      if (!confirm('Force-submit ' + studentId + '\'s exam now? It will be recorded as '
        + 'terminated by the administrator.')) return;
      api.post('/api/admin/force-submit',
        { studentId: studentId, quizId: state.monitorQuizId }, token)
        .then(refreshMonitor).catch(guard);
    }
  });

  $('monitorQuiz').addEventListener('change', function () {
    watch(Number(this.value));
  });

  $('toggleActive').addEventListener('click', function () {
    if (!state.monitorQuizId || !state.snapshot) return;
    var next = !state.snapshot.quiz.is_active;
    api.post('/api/admin/quizzes/' + state.monitorQuizId + '/activate', { active: next }, token)
      .then(function () { loadQuizzes(); refreshMonitor(); })
      .catch(guard);
  });

  /* ================= Violation feed ================= */

  function pushFeed(event) {
    if (Number(event.quizId) !== Number(state.monitorQuizId)) return;
    state.feed.unshift({
      student_id: event.studentId, reason: event.reason,
      severity: event.severity, created_at: event.at,
    });
    state.feed = state.feed.slice(0, 100);
    renderFeed();
  }

  function renderFeed() {
    var items = state.feed.map(function (f) {
      var studentId = f.student_id || f.studentId;
      var at = f.created_at || f.at;
      return '<div class="feed-item ' + esc(f.severity) + '">'
        + '<time>' + fmtTime(at) + '</time>'
        + '<strong>' + esc(studentId) + '</strong>'
        + '<span class="what">' + esc(f.reason)
        + (f.severity === 'FATAL' ? ' — attempt terminated' : '') + '</span>'
        + '</div>';
    });
    $('feed').innerHTML = items.join('');
    $('feedEmpty').hidden = items.length > 0;
  }

  /* ================= Quizzes ================= */

  function loadQuizzes() {
    api.get('/api/admin/quizzes', token).then(function (data) {
      state.quizzes = data.quizzes;
      renderQuizTable();
      fillQuizSelects();

      if (!state.monitorQuizId && state.quizzes.length) {
        var active = state.quizzes.find(function (q) { return q.is_active; });
        watch((active || state.quizzes[0]).quiz_id);
        $('monitorQuiz').value = String(state.monitorQuizId);
      }
    }).catch(guard);
  }

  function fillQuizSelects() {
    var options = state.quizzes.map(function (q) {
      return '<option value="' + q.quiz_id + '">' + esc(q.title)
        + (q.is_active ? ' (active)' : '') + '</option>';
    }).join('');

    ['monitorQuiz', 'resultsQuiz'].forEach(function (id) {
      var select = $(id);
      var previous = select.value;
      select.innerHTML = options || '<option value="">No quizzes</option>';
      if (previous && state.quizzes.some(function (q) { return String(q.quiz_id) === previous; })) {
        select.value = previous;
      }
    });
    if (state.monitorQuizId) $('monitorQuiz').value = String(state.monitorQuizId);
  }

  function renderQuizTable() {
    var rows = state.quizzes.map(function (q) {
      return '<tr>'
        + '<td class="num">' + q.quiz_id + '</td>'
        + '<td><strong>' + esc(q.title) + '</strong></td>'
        + '<td class="num">' + q.question_count + '</td>'
        + '<td class="num">' + q.duration_minutes + ' min</td>'
        + '<td>' + (q.shuffle_questions
            ? '<span class="pill IN_PROGRESS">shuffled</span>'
            : '<span class="pill NOT_STARTED">fixed</span>') + '</td>'
        + '<td><span class="pill ' + (q.is_active ? 'SUBMITTED' : 'NOT_STARTED') + '">'
          + (q.is_active ? 'ACTIVE' : 'inactive') + '</span></td>'
        + '<td class="actions">'
          + '<button class="btn small secondary" data-act="edit" data-id="' + q.quiz_id + '">Edit</button> '
          + '<button class="btn small secondary" data-act="duplicate" data-id="' + q.quiz_id
            + '">Duplicate</button> '
          + '<button class="btn small' + (q.is_active ? ' danger' : '') + '" data-act="toggle" data-id="'
            + q.quiz_id + '">' + (q.is_active ? 'Deactivate' : 'Activate') + '</button> '
          + '<button class="btn small danger" data-act="delete" data-id="' + q.quiz_id + '">Delete</button>'
        + '</td></tr>';
    });
    $('quizRows').innerHTML = rows.join('');
    $('quizEmpty').hidden = rows.length > 0;
  }

  $('quizRows').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var quizId = Number(btn.getAttribute('data-id'));
    var act = btn.getAttribute('data-act');

    if (act === 'edit') openEditor(quizId);

    if (act === 'toggle') {
      var quiz = state.quizzes.find(function (q) { return q.quiz_id === quizId; });
      api.post('/api/admin/quizzes/' + quizId + '/activate', { active: !quiz.is_active }, token)
        .then(function () { loadQuizzes(); refreshMonitor(); }).catch(guard);
    }

    if (act === 'duplicate') {
      // Disabled while in flight: a double click would otherwise make two copies.
      btn.disabled = true;
      api.post('/api/admin/quizzes/' + quizId + '/duplicate', {}, token)
        .then(function (res) {
          loadQuizzes();
          // Open the copy straight away — it is inactive and almost always about
          // to be edited, and seeing the editor makes clear which quiz is which.
          openEditor(res.quiz.quiz_id);
        })
        .catch(guard)
        .then(function () { btn.disabled = false; });
    }

    if (act === 'delete') {
      if (!confirm('Delete this quiz? All its questions, attempts and results will be '
        + 'permanently removed.')) return;
      api.del('/api/admin/quizzes/' + quizId, token).then(function () {
        if (state.monitorQuizId === quizId) state.monitorQuizId = null;
        closeEditor();
        loadQuizzes();
      }).catch(guard);
    }
  });

  /* ---------------- Quiz editor ---------------- */

  function questionEditorHtml(index, question) {
    var options = question ? question.options : ['', '', '', ''];
    var correct = question ? question.correct_option : 0;

    var optionRows = options.map(function (option, optIndex) {
      return '<div class="opt-row">'
        + '<input type="radio" name="correct-' + index + '" value="' + optIndex + '"'
          + (optIndex === correct ? ' checked' : '') + ' aria-label="Mark option '
          + LETTERS[optIndex] + ' correct">'
        + '<span class="key">' + LETTERS[optIndex] + '</span>'
        + '<input type="text" class="opt-input" maxlength="300" placeholder="Option '
          + LETTERS[optIndex] + '" value="' + esc(option) + '">'
        + '</div>';
    }).join('');

    var hasImage = !!(question && question.image);

    return '<div class="q-editor" data-index="' + index + '">'
      + '<header><strong>Question ' + (index + 1) + '</strong>'
      + '<button class="btn small secondary" data-act="remove-question">Remove</button></header>'
      + '<div class="field"><textarea class="q-text-input" maxlength="1000" '
        + 'placeholder="Type the question…">' + esc(question ? question.question_text : '')
        + '</textarea></div>'
      + '<div class="q-image' + (hasImage ? '' : ' empty') + '">'
        + '<img class="q-image-preview" alt="Question image preview"'
          + (hasImage ? ' src="' + esc(question.image) + '"' : '') + '>'
        + '<div class="q-image-actions">'
          + '<input type="file" class="q-image-input" accept="image/png,image/jpeg,'
            + 'image/gif,image/webp" hidden>'
          + '<button type="button" class="btn small secondary" data-act="pick-image">'
            + (hasImage ? 'Replace image' : '+ Add image') + '</button> '
          + '<button type="button" class="btn small secondary" data-act="remove-image"'
            + (hasImage ? '' : ' hidden') + '>Remove image</button>'
          + '<span class="q-image-note"></span>'
        + '</div>'
      + '</div>'
      + optionRows
      + '<p class="hint">Select the radio button beside the correct option.</p>'
      + '</div>';
  }

  /* ---------------- Question images ---------------- */

  var MAX_IMAGE_EDGE = 1280;   // downscale: exam screens never need more
  var JPEG_QUALITY = 0.85;
  var MAX_STORED_BYTES = 3 * 1024 * 1024;
  // A PNG larger than this is a photo or screenshot, not a line diagram, and
  // re-encodes far smaller as JPEG. It matters: every student downloads this
  // image at exam start, so a 1.3 MB PNG costs 78 MB across a 60-device room.
  var PNG_KEEP_LIMIT = 400 * 1024;

  /**
   * Reads a picked file and downscales it through a canvas. Phone photos are
   * routinely 4000px / 5 MB; sending those raw would bloat the database and
   * slow every exam load. PNGs stay PNG to keep diagrams and text crisp.
   */
  function prepareImage(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) {
        reject(new Error('That file is not an image.'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read that file.')); };
      reader.onload = function () {
        var img = new Image();
        img.onerror = function () { reject(new Error('That image could not be decoded.')); };
        img.onload = function () {
          var scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
          var width = Math.max(1, Math.round(img.width * scale));
          var height = Math.max(1, Math.round(img.height * scale));

          var canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          var ctx = canvas.getContext('2d');

          // JPEG has no alpha; without this, transparent areas turn black.
          var keepPng = file.type === 'image/png';
          if (!keepPng) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
          }
          ctx.drawImage(img, 0, 0, width, height);

          var dataUri = keepPng
            ? canvas.toDataURL('image/png')
            : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
          var format = keepPng ? 'PNG' : 'JPEG';

          // A photo or screenshot saved as PNG stays enormous. Re-encode it as
          // JPEG so students are not each downloading a megabyte per question.
          if (keepPng && dataUri.length * 0.75 > PNG_KEEP_LIMIT) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            var asJpeg = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
            // Only switch if it actually helps — flat diagrams can beat JPEG.
            if (asJpeg.length < dataUri.length) {
              dataUri = asJpeg;
              format = 'JPEG';
            }
          }

          if (dataUri.length * 0.75 > MAX_STORED_BYTES) {
            reject(new Error('That image is too large even after resizing. '
              + 'Try a smaller one.'));
            return;
          }
          resolve({
            dataUri: dataUri, width: width, height: height, format: format,
          });
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setQuestionImage(node, dataUri, note) {
    var wrap = node.querySelector('.q-image');
    var preview = node.querySelector('.q-image-preview');
    var removeBtn = node.querySelector('[data-act="remove-image"]');
    var pickBtn = node.querySelector('[data-act="pick-image"]');

    if (dataUri) {
      preview.src = dataUri;
      wrap.classList.remove('empty');
      removeBtn.hidden = false;
      pickBtn.textContent = 'Replace image';
    } else {
      preview.removeAttribute('src');
      wrap.classList.add('empty');
      removeBtn.hidden = true;
      pickBtn.textContent = '+ Add image';
      node.querySelector('.q-image-input').value = '';
    }
    node.querySelector('.q-image-note').textContent = note || '';
  }

  function renumberQuestions() {
    Array.prototype.forEach.call($('questionList').children, function (node, index) {
      node.setAttribute('data-index', index);
      node.querySelector('header strong').textContent = 'Question ' + (index + 1);
      Array.prototype.forEach.call(node.querySelectorAll('input[type="radio"]'), function (radio) {
        radio.name = 'correct-' + index;
      });
    });
  }

  function openEditor(quizId) {
    $('editorError').hidden = true;
    $('editorPanel').hidden = false;

    if (!quizId) {
      state.editing = null;
      $('editorTitle').textContent = 'New Quiz';
      $('quizTitleInput').value = '';
      $('quizDuration').value = '30';
      $('quizShuffle').checked = true;
      $('questionList').innerHTML = questionEditorHtml(0, null);
      $('editorPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    api.get('/api/admin/quizzes/' + quizId, token).then(function (data) {
      state.editing = quizId;
      $('editorTitle').textContent = 'Edit — ' + data.quiz.title;
      $('quizTitleInput').value = data.quiz.title;
      $('quizDuration').value = data.quiz.duration_minutes;
      $('quizShuffle').checked = data.quiz.shuffle_questions !== false;
      $('questionList').innerHTML = data.questions.length
        ? data.questions.map(function (q, i) { return questionEditorHtml(i, q); }).join('')
        : questionEditorHtml(0, null);
      $('editorPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(guard);
  }

  function closeEditor() {
    $('editorPanel').hidden = true;
    state.editing = null;
  }

  $('newQuiz').addEventListener('click', function () { openEditor(null); });
  $('closeEditor').addEventListener('click', closeEditor);

  $('addQuestion').addEventListener('click', function () {
    var index = $('questionList').children.length;
    $('questionList').insertAdjacentHTML('beforeend', questionEditorHtml(index, null));
  });

  $('questionList').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var node = btn.closest('.q-editor');
    var act = btn.getAttribute('data-act');

    if (act === 'remove-question') {
      if ($('questionList').children.length === 1) {
        showEditorError('A quiz needs at least one question.');
        return;
      }
      node.remove();
      renumberQuestions();
    }

    if (act === 'pick-image') node.querySelector('.q-image-input').click();
    if (act === 'remove-image') setQuestionImage(node, null, '');
  });

  $('questionList').addEventListener('change', function (e) {
    var input = e.target.closest('.q-image-input');
    if (!input || !input.files || !input.files[0]) return;
    var node = input.closest('.q-editor');

    node.querySelector('.q-image-note').textContent = 'Processing…';
    prepareImage(input.files[0]).then(function (result) {
      var kb = Math.round(result.dataUri.length * 0.75 / 1024);
      setQuestionImage(node, result.dataUri,
        result.width + '×' + result.height + ' · ' + result.format + ' · ' + kb + ' KB'
        + ' · every student downloads this');
    }).catch(function (err) {
      setQuestionImage(node, null, '');
      showEditorError(err.message);
    });
  });

  function showEditorError(message) {
    $('editorError').hidden = false;
    $('editorError').textContent = message;
    $('editorError').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function collectQuiz() {
    var title = $('quizTitleInput').value.trim();
    var duration = parseInt($('quizDuration').value, 10);
    if (!title) throw new Error('Enter an exam title.');
    if (!duration || duration < 1) throw new Error('Duration must be at least 1 minute.');

    var questions = Array.prototype.map.call($('questionList').children, function (node, index) {
      var text = node.querySelector('.q-text-input').value.trim();
      var options = Array.prototype.map.call(node.querySelectorAll('.opt-input'), function (input) {
        return input.value.trim();
      });
      var checked = node.querySelector('input[type="radio"]:checked');
      var preview = node.querySelector('.q-image-preview');
      var image = preview.getAttribute('src') || null;

      if (!text) throw new Error('Question ' + (index + 1) + ': enter the question text.');
      if (options.some(function (o) { return !o; })) {
        throw new Error('Question ' + (index + 1) + ': fill in all four options.');
      }
      if (!checked) throw new Error('Question ' + (index + 1) + ': mark the correct option.');

      return {
        question_text: text,
        options: options,
        image: image,
        correct_option: Number(checked.value),
      };
    });

    return {
      title: title,
      durationMinutes: duration,
      shuffleQuestions: $('quizShuffle').checked,
      questions: questions,
    };
  }

  $('saveQuiz').addEventListener('click', function () {
    var payload;
    try {
      payload = collectQuiz();
    } catch (err) {
      showEditorError(err.message);
      return;
    }

    $('editorError').hidden = true;
    $('saveQuiz').disabled = true;
    $('saveQuiz').textContent = 'Saving…';

    var request = state.editing
      ? api.put('/api/admin/quizzes/' + state.editing, payload, token)
      : api.post('/api/admin/quizzes', payload, token);

    request.then(function () {
      closeEditor();
      loadQuizzes();
    }).catch(function (err) {
      if (!guard(err)) showEditorError(err.message);
    }).then(function () {
      $('saveQuiz').disabled = false;
      $('saveQuiz').textContent = 'Save Quiz';
    });
  });

  /* ================= Results ================= */

  $('resultsQuiz').addEventListener('change', loadResults);

  function loadResults() {
    var quizId = Number($('resultsQuiz').value);
    if (!quizId) return;
    state.resultsQuizId = quizId;

    api.get('/api/admin/results/' + quizId, token).then(function (data) {
      var results = data.results;
      var scored = results.filter(function (r) { return r.status !== 'IN_PROGRESS'; });
      var scores = scored.map(function (r) { return r.score; });

      $('rStatCount').textContent = results.length;
      $('rStatAvg').textContent = scores.length
        ? (Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length * 10) / 10) + '%'
        : '—';
      $('rStatMax').textContent = scores.length ? Math.max.apply(null, scores) + '%' : '—';
      $('rStatMin').textContent = scores.length ? Math.min.apply(null, scores) + '%' : '—';

      var rows = results.map(function (r) {
        var display = r.status === 'TERMINATED' ? 'AUTO_TERMINATED' : r.status;
        return '<tr>'
          + '<td><strong>' + esc(r.studentId) + '</strong></td>'
          + '<td>' + esc(r.name) + '</td>'
          + '<td><span class="pill ' + display + '">' + display.replace(/_/g, ' ') + '</span></td>'
          + '<td class="num">' + (r.status === 'IN_PROGRESS' ? '—' : r.score + '%') + '</td>'
          + '<td class="num">' + r.correct + '/' + r.total + '</td>'
          + '<td>' + esc(r.submissionType || '—') + '</td>'
          + '<td class="num" title="' + esc((r.flags || []).map(function (f) {
              return fmtTime(f.at) + ' ' + f.reason;
            }).join(' | ')) + '">' + (r.flags || []).length + '</td>'
          + '<td>' + fmtTime(r.submittedAt) + '</td>'
          + '<td class="actions"><button class="btn small secondary" data-act="sheet" '
            + 'data-id="' + esc(r.studentId) + '">Responses</button></td>'
          + '</tr>';
      });

      $('resultRows').innerHTML = rows.join('');
      $('resultsEmpty').hidden = rows.length > 0;
      $('resultsHint').textContent = data.quiz.title + ' · automated scoring';

      // Keep an open sheet in sync when the table reloads.
      if (state.sheetStudentId
        && !results.some(function (r) { return r.studentId === state.sheetStudentId; })) {
        closeSheet();
      }
    }).catch(guard);
  }

  /* ---------------- Individual response sheet ---------------- */

  $('resultRows').addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-act="sheet"]');
    if (!btn) return;
    openSheet(btn.getAttribute('data-id'));
  });

  $('sheetClose').addEventListener('click', closeSheet);

  function closeSheet() {
    $('sheetPanel').hidden = true;
    state.sheetStudentId = null;
  }

  function openSheet(studentId) {
    var quizId = state.resultsQuizId;
    if (!quizId) return;

    api.get('/api/admin/results/' + quizId + '/student/'
      + encodeURIComponent(studentId), token).then(function (sheet) {
      state.sheetStudentId = studentId;
      renderSheet(sheet);
      $('sheetPanel').hidden = false;
      $('sheetPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(guard);
  }

  function renderSheet(sheet) {
    $('sheetTitle').textContent = sheet.student.studentId + ' — ' + sheet.student.name;

    var bits = [sheet.quiz.title];
    bits.push('submitted ' + fmtTime(sheet.attempt.submitTime));
    if (sheet.quiz.shuffled) {
      bits.push('shown in this student\'s randomized order (examiner numbering in brackets)');
    }
    $('sheetHint').textContent = bits.join(' · ');

    var c = sheet.counts;
    $('sheetStats').innerHTML = ''
      + statTile('Score', sheet.attempt.score + '%', sheet.attempt.status === 'TERMINATED' ? 'danger' : 'accent')
      + statTile('Correct', c.correct + '/' + c.total, 'ok')
      + statTile('Wrong', String(c.wrong), c.wrong ? 'danger' : '')
      + statTile('Blank', String(c.unanswered), c.unanswered ? 'warn' : '');

    if (sheet.attempt.status === 'TERMINATED') {
      $('sheetTerminated').hidden = false;
      $('sheetTerminated').textContent = 'Auto-terminated: '
        + (sheet.attempt.reason || 'policy violation')
        + (sheet.attempt.violations ? ' (' + sheet.attempt.violations + ' violation(s) logged)' : '');
    } else {
      $('sheetTerminated').hidden = true;
    }

    $('sheetBody').innerHTML = sheet.questions.map(function (item) {
      var kind = !item.answered ? 'blank' : (item.isCorrect ? 'correct' : 'wrong');
      var verdict = !item.answered ? 'NOT ANSWERED' : (item.isCorrect ? 'CORRECT' : 'WRONG');

      var numbering = 'Question ' + item.shownAs;
      if (item.shownAs !== item.authoredAs) {
        numbering += ' <small>[examiner Q' + item.authoredAs + ']</small>';
      }

      var img = item.has_image
        ? '<img class="q-img" alt="Question image" src="/api/quiz/image/' + item.question_id
          + '?adminToken=' + encodeURIComponent(token) + '">'
        : '';

      var opts = item.options.map(function (option, index) {
        var isKey = index === item.correct_option;
        var isPick = index === item.chosen;
        var cls = 'sheet-opt';
        if (isKey) cls += ' is-key';
        if (isPick) cls += ' is-pick';
        if (isPick && !isKey) cls += ' is-pick-wrong';

        var mark = isKey ? '✓' : (isPick ? '✗' : '');
        var tags = [];
        if (isPick) tags.push('student\'s answer');
        if (isKey) tags.push('correct answer');

        return '<div class="' + cls + '">'
          + '<span class="mark">' + mark + '</span>'
          + '<span class="letter">' + (LETTERS[index] || index + 1) + '.</span>'
          + '<span>' + esc(option) + '</span>'
          + (tags.length ? '<span class="tag">' + tags.join(' · ') + '</span>' : '')
          + '</div>';
      }).join('');

      return '<div class="sheet-q ' + kind + '">'
        + '<header><span class="q-no">' + numbering + '</span>'
        + '<span class="verdict">' + verdict + '</span></header>'
        + '<div class="q-body">' + esc(item.question_text) + '</div>'
        + img + opts
        + '</div>';
    }).join('');
  }

  function statTile(label, value, kind) {
    return '<div class="stat ' + (kind || '') + '"><div class="k">' + esc(label)
      + '</div><div class="v">' + esc(value) + '</div></div>';
  }

  /**
   * Fetches a generated file and hands it to the browser as a blob.
   *
   * Navigating to the URL instead (window.location) has two problems on this
   * setup: a `Content-Disposition: attachment` reply is saved silently rather
   * than displayed, and Chrome/Edge block some downloads started that way from
   * a plain-HTTP origin — so the click appeared to do nothing at all. A blob is
   * same-origin, always allowed, and can be opened in the PDF viewer.
   *
   * It also keeps the admin token in a header instead of the URL.
   */
  function fetchFile(url, button, mode, filename) {
    var label = button ? button.textContent : null;
    if (button) { button.disabled = true; button.textContent = 'Preparing…'; }

    return fetch(url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            throw new Error(data.error || ('Could not generate the file (' + res.status + ')'));
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        var objectUrl = URL.createObjectURL(blob);

        if (mode === 'view') {
          var win = window.open(objectUrl, '_blank');
          if (!win) {
            // Pop-up blocked — fall back to saving it instead of failing quietly.
            triggerSave(objectUrl, filename);
            guard(new Error('Your browser blocked the new tab, so the PDF was '
              + 'downloaded instead. Allow pop-ups for this site to view it inline.'));
          }
        } else {
          triggerSave(objectUrl, filename);
        }

        // Give the tab time to claim the blob before releasing it.
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
      })
      .catch(function (err) { guard(err); })
      .then(function () {
        if (button) { button.disabled = false; button.textContent = label; }
      });
  }

  function triggerSave(objectUrl, filename) {
    var a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function sheetFileName() {
    return 'answers-' + String(state.sheetStudentId).replace(/[^a-z0-9]+/gi, '-') + '.pdf';
  }

  $('sheetPdf').addEventListener('click', function () {
    if (!state.resultsQuizId || !state.sheetStudentId) return;
    fetchFile('/api/admin/results/' + state.resultsQuizId + '/student/'
      + encodeURIComponent(state.sheetStudentId) + '/answers.pdf',
    this, 'view', sheetFileName());
  });

  $('sheetPdfSave').addEventListener('click', function () {
    if (!state.resultsQuizId || !state.sheetStudentId) return;
    fetchFile('/api/admin/results/' + state.resultsQuizId + '/student/'
      + encodeURIComponent(state.sheetStudentId) + '/answers.pdf',
    this, 'save', sheetFileName());
  });

  $('exportAllPdf').addEventListener('click', function () {
    var quizId = Number($('resultsQuiz').value);
    if (!quizId) return;
    fetchFile('/api/admin/results/' + quizId + '/answers.pdf',
      this, 'save', 'answers-all-quiz-' + quizId + '.pdf');
  });

  $('exportCsv').addEventListener('click', function () {
    var quizId = Number($('resultsQuiz').value);
    if (!quizId) return;
    fetchFile('/api/admin/results/' + quizId + '/export.csv',
      this, 'save', 'results-quiz-' + quizId + '.csv');
  });

  /* ================= Network / QR ================= */

  /**
   * Keeps the join address honest. DHCP can move this machine to a new address
   * mid-session, which silently invalidates every projected QR code and every
   * student's bookmark — so poll for it and shout when it changes.
   */
  function loadNetwork() {
    api.get('/api/network').then(function (data) {
      var changed = state.joinUrl && state.joinUrl !== data.url;
      state.joinUrl = data.url;

      $('joinUrl').textContent = data.url;
      $('ifaceHint').textContent = 'Serving on interface "' + data.interface + '" — port '
        + data.port + '. Students must be on the same Wi-Fi network.';
      // Cache-bust so the QR never lags the address it encodes.
      $('qrImage').src = '/api/qr.png?v=' + encodeURIComponent(data.url);

      var warn = $('netWarning');
      if (data.changedSinceStart || changed) {
        warn.hidden = false;
        warn.innerHTML = '<strong>This machine\'s address changed.</strong> '
          + 'It was <code>' + esc(data.bootAddress) + '</code> when the server started and is '
          + 'now <code>' + esc(data.host) + '</code>. Anything showing the old address — a '
          + 'printed sheet, a photographed QR code, a student\'s bookmark — will fail with '
          + '"site can\'t be reached". Show the new address above, and ask your network admin '
          + 'to reserve a fixed address for this machine.';
      } else {
        warn.hidden = true;
      }
    }).catch(function () { /* network panel is informational */ });
  }

  $('copyUrl').addEventListener('click', function () {
    var url = $('joinUrl').textContent;
    var done = function () {
      $('copyUrl').textContent = 'Copied';
      setTimeout(function () { $('copyUrl').textContent = 'Copy address'; }, 1600);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, function () {});
    else done();
  });

  /* ================= Boot ================= */

  if (token) {
    api.get('/api/admin/session', token).then(enterShell).catch(function () {
      sessionStorage.removeItem('admin.token');
      token = null;
      showGate(null);
    });
  } else {
    showGate(null);
  }

  // Periodic reconcile in case a socket event was missed.
  setInterval(function () {
    if (token && !$('shell').hidden && state.view === 'monitor') refreshMonitor();
  }, 15000);

  // Watch for a DHCP address change even while another tab is in view, so the
  // Join Info panel is never showing a dead address when you switch to it.
  setInterval(function () {
    if (token && !$('shell').hidden) loadNetwork();
  }, 30000);
})();
