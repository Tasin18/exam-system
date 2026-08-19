/**
 * The parts of the console that exist only for the administrator: teacher
 * accounts and the school-wide student roster.
 *
 * Loaded by /admin and not by /teacher, so none of this markup or code reaches
 * a teacher's browser. That is presentation, not protection — every endpoint
 * below is also refused by the server for anyone who is not the administrator.
 */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var api = null;
  var getToken = function () { return null; };
  var guard = function () {};
  var teachers = [];

  function esc(value) { return global.esc(value); }

  /* ================= Teachers ================= */

  function loadTeachers() {
    if (!$('teacherRows')) return;
    api.get('/api/admin/teachers', getToken()).then(function (data) {
      teachers = data.teachers;
      renderTeachers();
    }).catch(guard);
  }

  function renderTeachers() {
    var rows = teachers.map(function (t) {
      return '<tr>'
        + '<td><strong>' + esc(t.displayName) + '</strong></td>'
        + '<td>' + esc(t.username) + '</td>'
        + '<td class="num">' + (t.quizCount || 0) + '</td>'
        + '<td><span class="pill ' + (t.isActive ? 'SUBMITTED' : 'NOT_STARTED') + '">'
          + (t.isActive ? 'active' : 'disabled') + '</span></td>'
        + '<td>' + (t.lastLogin ? global.fmtTime(t.lastLogin) : 'never') + '</td>'
        + '<td class="actions">'
          + '<button class="btn small secondary" data-act="password" data-id="'
            + t.teacherId + '">Set password</button> '
          + '<button class="btn small' + (t.isActive ? ' danger' : ' secondary')
            + '" data-act="toggle" data-id="' + t.teacherId + '">'
            + (t.isActive ? 'Disable' : 'Enable') + '</button> '
          + '<button class="btn small danger" data-act="delete" data-id="'
            + t.teacherId + '">Delete</button>'
        + '</td></tr>';
    });
    $('teacherRows').innerHTML = rows.join('');
    $('teacherEmpty').hidden = rows.length > 0;
  }

  function showTeacherError(message) {
    var box = $('teacherError');
    if (!box) return;
    box.hidden = !message;
    box.textContent = message || '';
  }

  function bindTeachers() {
    if (!$('teacherForm')) return;

    $('teacherForm').addEventListener('submit', function (e) {
      e.preventDefault();
      showTeacherError('');
      api.post('/api/admin/teachers', {
        displayName: $('teacherName').value.trim(),
        username: $('teacherUsername').value.trim(),
        password: $('teacherPassword').value,
      }, getToken()).then(function () {
        $('teacherForm').reset();
        loadTeachers();
      }).catch(function (err) {
        if (!guard(err)) showTeacherError(err.message);
      });
    });

    $('teacherRows').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = Number(btn.getAttribute('data-id'));
      var teacher = teachers.find(function (t) { return t.teacherId === id; });
      if (!teacher) return;

      var act = btn.getAttribute('data-act');

      if (act === 'toggle') {
        // Spelled out, because disabling is not merely cosmetic: it also cuts
        // any session that teacher currently holds.
        var verb = teacher.isActive ? 'Disable' : 'Enable';
        if (teacher.isActive && !window.confirm(verb + ' ' + teacher.displayName
          + '? They will be signed out immediately and cannot sign in again '
          + 'until you re-enable them. Their quizzes and results are kept.')) return;
        api.put('/api/admin/teachers/' + id, { isActive: !teacher.isActive }, getToken())
          .then(loadTeachers).catch(guard);
        return;
      }

      if (act === 'password') {
        var next = window.prompt('New password for ' + teacher.displayName + ':');
        if (!next) return;
        api.put('/api/admin/teachers/' + id, { password: next }, getToken())
          .then(function () {
            loadTeachers();
            window.alert('Password updated. ' + teacher.displayName
              + ' has been signed out of any open session.');
          })
          .catch(function (err) {
            if (!guard(err)) showTeacherError(err.message);
          });
        return;
      }

      if (act === 'delete') {
        if (!window.confirm('Delete the account for ' + teacher.displayName + '?\n\n'
          + 'Their ' + (teacher.quizCount || 0) + ' quiz(zes) and every result '
          + 'recorded against them are KEPT and transfer to you. Only the login '
          + 'is removed.')) return;
        api.del('/api/admin/teachers/' + id, getToken())
          .then(loadTeachers).catch(guard);
      }
    });
  }

  /* ================= Student roster ================= */

  function loadStudents() {
    if (!$('studentRows')) return;
    api.get('/api/admin/students', getToken()).then(function (data) {
      var rows = data.students.map(function (s) {
        return '<tr>'
          + '<td><strong>' + esc(s.student_id) + '</strong></td>'
          + '<td>' + esc(s.name) + '</td>'
          + '<td>' + (s.created_at ? global.fmtTime(s.created_at) : '—') + '</td>'
          + '<td class="actions"><button class="btn small danger" data-act="delete" '
            + 'data-id="' + esc(s.student_id) + '">Remove</button></td>'
          + '</tr>';
      });
      $('studentRows').innerHTML = rows.join('');
      $('studentEmpty').hidden = rows.length > 0;
      $('studentCount').textContent = data.students.length;
    }).catch(guard);
  }

  function bindStudents() {
    if (!$('studentRows')) return;
    $('studentRows').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act="delete"]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      // Blunt and worth spelling out: this is the only action in the console
      // that reaches across every teacher's exams at once.
      if (!window.confirm('Remove ' + id + ' from the roster?\n\n'
        + 'This deletes every attempt and result this student has, in EVERY '
        + 'teacher\'s quiz. It cannot be undone. To let them retake one exam, '
        + 'use "Grant retake" on the Live Monitor instead.')) return;
      api.del('/api/admin/students/' + encodeURIComponent(id), getToken())
        .then(loadStudents).catch(guard);
    });
    $('refreshStudents').addEventListener('click', loadStudents);
  }

  /* ================= Wiring ================= */

  global.adminExtras = {
    init: function (apiRef, tokenGetter, guardFn) {
      api = apiRef;
      getToken = tokenGetter;
      guard = guardFn;
      bindTeachers();
      bindStudents();
      loadTeachers();
      loadStudents();
    },
    loadTeachers: loadTeachers,
    loadStudents: loadStudents,
  };
})(window);
