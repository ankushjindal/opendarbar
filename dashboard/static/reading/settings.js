// What he has decided about the reading pages, kept in one place and applied
// everywhere rather than per note. One JSON object in localStorage, because a
// preference about how a page behaves is a fact about this browser and does not
// belong in his vault — the note keeps what he read and how far, not how he
// likes the scrolling.
//
// The contract, which other scripts on these pages are written against:
//
//   RLSettings.get(key, fallback)   the value, the fallback, or the default
//   RLSettings.set(key, value)      writes it and tells everyone listening
//   RLSettings.on(key, fn)          fn(value) now, and again on every change
//
// `on` firing once immediately is the point: a consumer says what to do with
// the value in one place and never has to read it separately at startup.

(function (g) {
  "use strict";

  var KEY = "rl-settings";

  // A setting with no default is a setting nothing can sensibly do with the
  // first time it is read, so every one of them has its answer here.
  var DEFAULTS = {
    // Keep what is being spoken, or said in the video, in view while it plays.
    scrollSync: true,
    // Hold the video at the top of the screen while the transcript runs under it.
    "pin-player": true,
  };

  var data = null;
  var subs = {};

  function load() {
    if (data) return data;
    try { data = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }
    catch (e) { data = {}; }
    if (typeof data !== "object") data = {};
    return data;
  }

  function get(key, fallback) {
    var d = load();
    if (Object.prototype.hasOwnProperty.call(d, key)) return d[key];
    if (arguments.length > 1) return fallback;
    return DEFAULTS[key];
  }

  function tell(key, value) {
    var list = subs[key];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](value); } catch (e) {}
    }
  }

  function set(key, value) {
    var d = load();
    if (d[key] === value) return;
    d[key] = value;
    try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {}
    tell(key, value);
  }

  function on(key, fn) {
    (subs[key] = subs[key] || []).push(fn);
    try { fn(get(key)); } catch (e) {}
  }

  // The list in one tab and the reader in another are the same setting. A
  // storage event only fires in the other tabs, which is exactly right.
  g.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    var was = load();
    data = null;
    var now = load();
    var keys = {};
    Object.keys(was).forEach(function (k) { keys[k] = 1; });
    Object.keys(now).forEach(function (k) { keys[k] = 1; });
    Object.keys(subs).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (was[k] !== now[k]) tell(k, get(k));
    });
  });

  g.RLSettings = { get: get, set: set, on: on, defaults: DEFAULTS };
})(window);
