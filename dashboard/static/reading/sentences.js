// Where a sentence ends. One rule, one file, because two pieces of code have to
// agree about it to the sentence: reading-audio.ts numbers the sentences of a
// spoken block so the aligner can hang word times on them, and reader.js splits
// the same block's text in the DOM to wrap those sentences in spans. A cue says
// "block 12, sentence 3"; if the two disagree by one sentence anywhere in a
// paragraph, the voice and the mark on the page come apart and stay apart.
//
// So this is the block selector's twin: the selector lives in one place because
// the indices depend on it, and this lives in one place because the sentence
// numbers do. The server imports this file; the browser loads it as one more
// chrome script and takes the same functions off window.

(function (g) {
  "use strict";

  // A raw URL read aloud is a minute of punctuation, so the text prepared for
  // the voice drops them and keeps the words that linked to them. The reader
  // has to drop exactly the same characters or its sentence offsets slide.
  function urlRe() { return /https?:\/\/\S+/g; }

  // The words that end in a full stop without ending a sentence. Titles and
  // the handful of Latin abbreviations that actually turn up in prose; the
  // single-capital rule below covers initials (J. Smith) and the dotted
  // acronyms (U.S., Ph.D.) without listing them.
  //
  // Deliberately absent: "no", "am", "pm", "co". Each is a common enough word
  // that blocking a split after it costs more sentences than it saves.
  var ABBR = {
    "mr": 1, "mrs": 1, "ms": 1, "dr": 1, "prof": 1, "sr": 1, "jr": 1, "st": 1,
    "mt": 1, "lt": 1, "col": 1, "gen": 1, "rev": 1, "hon": 1, "capt": 1,
    "vs": 1, "etc": 1, "e.g": 1, "i.e": 1, "eg": 1, "ie": 1, "al": 1, "cf": 1,
    "viz": 1, "inc": 1, "ltd": 1, "corp": 1, "dept": 1, "est": 1, "approx": 1,
    "fig": 1, "figs": 1, "vol": 1, "pp": 1, "ch": 1, "ed": 1, "eds": 1,
    "jan": 1, "feb": 1, "mar": 1, "apr": 1, "jun": 1, "jul": 1, "aug": 1,
    "sep": 1, "sept": 1, "oct": 1, "nov": 1, "dec": 1,
    "mon": 1, "tue": 1, "tues": 1, "wed": 1, "thu": 1, "thurs": 1, "fri": 1, "sat": 1
  };

  // What may close a sentence after the stop: a quote or a bracket.
  var CLOSERS = "\"')”’]»";
  // What may open the next one. A lower-case letter after a full stop is an
  // abbreviation we did not list, a decimal, or a mid-sentence ellipsis, and in
  // all three cases the sentence has not ended.
  var OPENS = /[A-Z0-9À-Þ"'“‘(\[«—]/;

  // The token immediately before a stop, letters and interior dots only, so
  // "e.g." gives "e.g" and "Mr." gives "Mr".
  function tokenBefore(text, dot) {
    var i = dot;
    while (i > 0 && /[A-Za-z.]/.test(text.charAt(i - 1))) i--;
    return text.slice(i, dot);
  }

  function isAcronym(word) {
    var parts = word.split(".");
    for (var k = 0; k < parts.length; k++) {
      if (parts[k].length < 1 || parts[k].length > 2) return false;
    }
    return true;
  }

  // Every sentence in `text`, as [start, end) offsets into it. The offsets
  // matter more than the strings: the reader maps them back onto the text nodes
  // they came from, and a returned substring could not be mapped to anything.
  //
  // The text handed in is already collapsed to single spaces (the preparer does
  // it with a regex, the reader does it while walking the DOM), so this only has
  // to worry about where the stops are, not about what whitespace looks like.
  function ranges(text) {
    var out = [];
    var n = text.length;
    var start = 0;
    var i = 0;
    while (i < n) {
      var c = text.charAt(i);
      if (c !== "." && c !== "!" && c !== "?" && c !== "…") { i++; continue; }
      var dot = i;
      // A run of stops is one stop: "?!" and "..." both end once.
      while (i < n && ".!?…".indexOf(text.charAt(i)) >= 0) i++;
      // ...plus whatever closes the quotation it was inside.
      while (i < n && CLOSERS.indexOf(text.charAt(i)) >= 0) i++;
      var j = i;
      while (j < n && text.charAt(j) === " ") j++;
      if (j === i) continue;                       // no space after it: not a break
      if (j >= n) break;                           // trailing stop; the tail is the last sentence
      if (!OPENS.test(text.charAt(j))) continue;   // lower case: the sentence goes on
      if (text.charAt(dot) === ".") {
        var word = tokenBefore(text, dot);
        var key = word.toLowerCase().replace(/^\.+/, "");
        if (ABBR[key]) { i = j; continue; }
        // An initial: "J. Smith", "W. E. B. Du Bois".
        if (word.length === 1 && word >= "A" && word <= "Z") { i = j; continue; }
        // A dotted acronym: U.S., U.K., Ph.D., a.m. Every piece between the
        // dots is a letter or two, which no ordinary word ending in a full
        // stop ever is, so this needs no list to keep up to date.
        if (word.indexOf(".") > 0 && isAcronym(word)) { i = j; continue; }
      }
      out.push([start, i]);
      start = j;
      i = j;
    }
    if (start < n) out.push([start, n]);
    // A stop with nothing but space after it leaves an empty tail; drop it.
    return out.filter(function (r) { return text.slice(r[0], r[1]).trim().length > 0; });
  }

  // The same split as strings, for the places that only want the text.
  function split(text) {
    return ranges(text).map(function (r) { return text.slice(r[0], r[1]).trim(); });
  }

  var api = { ranges: ranges, split: split, urlRe: urlRe };
  g.rlSentences = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
