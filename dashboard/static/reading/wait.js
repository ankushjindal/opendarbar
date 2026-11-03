// The note has no body yet. add.sh is running behind this page; ask every
// second and a half until it has an answer either way, then go back in.
(function () {
  var f = RL.file;
  var wait = document.getElementById("rl-wait");
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (tries > 60) { clearInterval(timer); wait.textContent = "Still fetching. Try again later."; return; }
    fetch("/api/reading/fetch-state?f=" + encodeURIComponent(f))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j.ready) { clearInterval(timer); location.replace(RL.back); return; }
        if (j.failed) { clearInterval(timer); location.replace(RL.back); }
      }).catch(function () {});
  }, 1500);
})();
