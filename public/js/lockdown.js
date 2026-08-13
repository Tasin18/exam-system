/**
 * Client lockdown / anti-cheat enforcement.
 *
 * Policy (Module B.3): a focus breach locks the screen immediately, fires an
 * auto-submit, and the attempt is recorded as TERMINATED.
 *
 * Every action is declared in POLICY below so the strictness can be changed in
 * one place. 'submit' terminates the attempt; 'flag' records the violation for
 * the invigilator and lets the exam continue.
 */
(function (global) {
  'use strict';

  var POLICY = {
    tabHidden:       'submit', // Page Visibility API — tab switch / minimize
    windowBlur:      'submit', // window.onblur — focus left the exam window
    fullscreenExit:  'submit', // fullscreenchange — left fullscreen
    // mouseleave fires whenever the cursor crosses the viewport edge, which
    // happens innocently on multi-monitor setups and while reaching for a
    // scrollbar. Recorded for the invigilator rather than auto-terminating.
    // Change to 'submit' for the strictest possible reading of the spec.
    pointerLeave:    'flag',
    devtoolsKeys:    'flag',   // blocked regardless; this is the extra record
  };

  // The fullscreen request and the browser's own permission UI both shuffle
  // focus. Listeners arm only after the transition settles, otherwise the
  // lockdown terminates the exam it just started.
  var ARM_DELAY_MS = 1200;

  // Repeated pointer exits shouldn't spam the invigilator's feed.
  var FLAG_THROTTLE_MS = 4000;

  function Lockdown(options) {
    this.onTerminate = options.onTerminate || function () {};
    this.onFlag = options.onFlag || function () {};
    this.onWarn = options.onWarn || function () {};
    this.armed = false;
    this.finished = false;
    this.bindings = [];
    this.lastFlagAt = {};
  }

  Lockdown.prototype.on = function (target, type, handler, opts) {
    target.addEventListener(type, handler, opts || false);
    this.bindings.push({ target: target, type: type, handler: handler, opts: opts || false });
  };

  Lockdown.prototype.release = function () {
    this.armed = false;
    for (var i = 0; i < this.bindings.length; i++) {
      var b = this.bindings[i];
      b.target.removeEventListener(b.type, b.handler, b.opts);
    }
    this.bindings = [];
  };

  /** Requests fullscreen. Resolves true if granted. */
  Lockdown.prototype.requestFullscreen = function () {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!fn) return Promise.resolve(false);
    try {
      var result = fn.call(el, { navigationUI: 'hide' });
      if (result && typeof result.then === 'function') {
        return result.then(function () { return true; }, function () { return false; });
      }
      return Promise.resolve(true);
    } catch (err) {
      return Promise.resolve(false);
    }
  };

  Lockdown.prototype.isFullscreen = function () {
    return !!(document.fullscreenElement || document.webkitFullscreenElement
      || document.msFullscreenElement);
  };

  Lockdown.prototype.exitFullscreen = function () {
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (fn && this.isFullscreen()) {
      try { fn.call(document); } catch (err) { /* already exiting */ }
    }
  };

  /** Fires the configured action for a violation. One terminate, ever. */
  Lockdown.prototype.violate = function (key, reason) {
    if (this.finished) return;
    var action = POLICY[key] || 'flag';

    if (action === 'submit') {
      if (!this.armed) return;
      this.finished = true;
      this.release();
      this.onTerminate(reason);
      return;
    }

    var now = Date.now();
    if (this.lastFlagAt[key] && now - this.lastFlagAt[key] < FLAG_THROTTLE_MS) return;
    this.lastFlagAt[key] = now;
    this.onFlag(reason);
    this.onWarn(reason);
  };

  /** Input lock: context menu, selection, clipboard, drag, devtools keys. */
  Lockdown.prototype.lockInput = function () {
    var self = this;
    var block = function (e) { e.preventDefault(); return false; };

    this.on(document, 'contextmenu', block);
    this.on(document, 'selectstart', function (e) {
      // Typed input must still work if short-answer questions are added later.
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
    });
    this.on(document, 'dragstart', block);
    this.on(document, 'copy', block);
    this.on(document, 'cut', block);
    this.on(document, 'paste', block);

    this.on(document, 'keydown', function (e) {
      var key = e.key || '';
      var upper = key.length === 1 ? key.toUpperCase() : key;

      var isDevtools = key === 'F12'
        || (e.ctrlKey && e.shiftKey && (upper === 'I' || upper === 'J' || upper === 'C'))
        || (e.metaKey && e.altKey && (upper === 'I' || upper === 'J' || upper === 'C'));
      var isViewSource = (e.ctrlKey || e.metaKey) && upper === 'U';
      var isClipboard = (e.ctrlKey || e.metaKey) && (upper === 'C' || upper === 'V' || upper === 'X' || upper === 'A');
      var isPrint = (e.ctrlKey || e.metaKey) && upper === 'P';
      var isSave = (e.ctrlKey || e.metaKey) && upper === 'S';
      var isFind = (e.ctrlKey || e.metaKey) && upper === 'F';
      var isReload = key === 'F5' || ((e.ctrlKey || e.metaKey) && upper === 'R');
      var isNewTab = (e.ctrlKey || e.metaKey) && (upper === 'T' || upper === 'N' || upper === 'W');

      if (isDevtools || isViewSource) {
        e.preventDefault();
        e.stopPropagation();
        self.violate('devtoolsKeys', 'Blocked developer-tools shortcut (' + describe(e) + ')');
        return false;
      }
      if (isClipboard || isPrint || isSave || isFind || isReload || isNewTab) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
      return undefined;
    }, true);
  };

  function describe(e) {
    var parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.metaKey) parts.push('Meta');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(e.key);
    return parts.join('+');
  }

  /** Focus / visibility / fullscreen tracking. */
  Lockdown.prototype.watchFocus = function () {
    var self = this;

    this.on(document, 'visibilitychange', function () {
      if (document.hidden) self.violate('tabHidden', 'Tab switch or window minimized');
    });

    this.on(global, 'blur', function () {
      // A blur whose new focus target is still inside our own document (an
      // iframe, a native <select> popup) is not the student leaving the exam.
      setTimeout(function () {
        if (document.hidden || !document.hasFocus()) {
          self.violate('windowBlur', 'Lost window focus');
        }
      }, 60);
    });

    this.on(document, 'fullscreenchange', function () { self.checkFullscreen(); });
    this.on(document, 'webkitfullscreenchange', function () { self.checkFullscreen(); });

    this.on(document, 'mouseleave', function (e) {
      // Only a genuine exit through the viewport edge, not a hover into a child.
      if (e.relatedTarget || e.toElement) return;
      self.violate('pointerLeave', 'Pointer left the exam window');
    });

    this.on(global, 'resize', function () {
      // Chrome/Edge report a fullscreen exit as a resize before the
      // fullscreenchange event on some platforms.
      if (self.armed && self.wantFullscreen && !self.isFullscreen()) {
        self.checkFullscreen();
      }
    });

    this.on(global, 'beforeunload', function (e) {
      if (self.finished) return undefined;
      e.preventDefault();
      e.returnValue = 'Leaving this page will submit your exam.';
      return e.returnValue;
    });
  };

  Lockdown.prototype.checkFullscreen = function () {
    if (!this.wantFullscreen || this.finished) return;
    if (this.isFullscreen()) return;
    this.violate('fullscreenExit', 'Exited fullscreen mode');
  };

  /**
   * Engages the lockdown. MUST be called from a user gesture (a click) or the
   * browser will refuse the fullscreen request.
   */
  Lockdown.prototype.start = function () {
    var self = this;
    this.lockInput();
    this.watchFocus();

    return this.requestFullscreen().then(function (granted) {
      self.wantFullscreen = granted;
      // Arm after the transition settles so the fullscreen switch itself, and
      // the focus shuffle around it, don't count as violations.
      return new Promise(function (resolve) {
        setTimeout(function () {
          self.armed = true;
          resolve({ fullscreen: granted });
        }, ARM_DELAY_MS);
      });
    });
  };

  /** Clean teardown for a legitimate submit — must run before the beforeunload. */
  Lockdown.prototype.finish = function () {
    this.finished = true;
    this.release();
    this.exitFullscreen();
  };

  Lockdown.POLICY = POLICY;
  global.Lockdown = Lockdown;
})(window);
