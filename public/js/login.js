/** Student login + pre-exam verification. */
(function () {
  'use strict';

  var form = document.getElementById('loginForm');
  var idInput = document.getElementById('studentId');
  var nameInput = document.getElementById('name');
  var submitBtn = document.getElementById('submitBtn');
  var errorBox = document.getElementById('error');
  var titleEl = document.getElementById('quizTitle');
  var metaEl = document.getElementById('quizMeta');
  var dot = document.getElementById('statusDot');
  var rules = document.getElementById('rules');

  var activeQuiz = null;

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function clearError() { errorBox.hidden = true; }

  // Clear any stale session left by a previous attempt on this device.
  sessionStorage.removeItem('exam.session');

  function loadActive() {
    api.get('/api/quiz/active').then(function (data) {
      if (!data.active) {
        dot.style.background = '#9a6206';
        dot.style.boxShadow = '0 0 0 4px #fdf2dd';
        titleEl.textContent = 'No exam is open right now';
        metaEl.textContent = 'Keep this page open — it will update automatically when your '
          + 'invigilator starts the exam.';
        submitBtn.disabled = true;
        rules.hidden = true;
        setTimeout(loadActive, 5000);
        return;
      }
      activeQuiz = data;
      rules.hidden = false;
      titleEl.textContent = data.title;
      metaEl.textContent = data.questionCount + ' question'
        + (data.questionCount === 1 ? '' : 's') + ' · ' + data.durationMinutes
        + ' minute time limit · one attempt';
      submitBtn.disabled = false;
    }).catch(function (err) {
      dot.style.background = '#b3261e';
      dot.style.boxShadow = '0 0 0 4px #fdeceb';
      titleEl.textContent = 'Cannot reach the exam server';
      metaEl.textContent = err.message + ' Retrying…';
      submitBtn.disabled = true;
      setTimeout(loadActive, 4000);
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearError();
    if (!activeQuiz) return;

    var studentId = idInput.value.trim();
    var name = nameInput.value.trim();
    if (!studentId || !name) {
      showError('Enter both your Student ID and your full name.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Verifying…';

    api.post('/api/auth/login', {
      studentId: studentId, name: name, quizId: activeQuiz.quizId,
    }).then(function (data) {
      sessionStorage.setItem('exam.session', JSON.stringify({
        token: data.token,
        studentId: data.student.studentId,
        name: data.student.name,
        quizId: data.quiz.quizId,
        title: data.quiz.title,
        endsAt: data.endsAt,
        resumed: data.resumed,
      }));
      window.location.href = '/exam';
    }).catch(function (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Start Exam';
    });
  });

  idInput.addEventListener('input', clearError);
  nameInput.addEventListener('input', clearError);

  loadActive();
})();
