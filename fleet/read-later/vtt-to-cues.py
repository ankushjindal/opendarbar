#!/opt/homebrew/bin/python3
"""Turn a WebVTT subtitle file into timestamped transcript paragraphs.

    vtt-to-cues.py sub.vtt  ->  **0:00** · Hi, I'm Robert Sapolsky. ...

Two shapes of subtitle come out of YouTube and both land here:

  * published captions, one tidy cue every few seconds, carrying &nbsp; between
    words (which is where the doubled spaces in the reader came from), and
  * auto-generated captions, which roll: each cue repeats the tail of the one
    before it with a word or two added.

Cues are cleaned, the rolling overlap is removed by matching the longest word
suffix of what we already have against the head of the next cue, and the result
is merged into paragraph-sized blocks of roughly half a minute that prefer to
end on a sentence. Output is one block per line in the convention the vault
already uses, blank line separated.
"""
import html
import re
import sys

MIN_BLOCK = 25.0   # seconds: do not cut a paragraph shorter than this
MAX_BLOCK = 38.0   # seconds: cut here even without a sentence ending

TIME = re.compile(
    r"^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})"
)


def secs(h, m, s, ms):
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000.0


def clean(line):
    line = re.sub(r"<[^>]*>", "", line)          # <00:00:01.000> and <c> spans
    line = html.unescape(line)
    line = line.replace(" ", " ").replace("​", "")
    return re.sub(r"\s+", " ", line).strip()


def parse(path):
    cues = []
    start = None
    buf = []
    with open(path, "r", encoding="utf-8", errors="ignore") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            m = TIME.match(line.strip())
            if m:
                if start is not None and buf:
                    cues.append((start, " ".join(buf)))
                start = secs(m.group(1), m.group(2), m.group(3), m.group(4))
                buf = []
                continue
            if line.strip() in ("", "WEBVTT") or line.startswith(("Kind:", "Language:", "NOTE", "STYLE")):
                continue
            if start is None:
                continue
            text = clean(line)
            if text:
                buf.append(text)
    if start is not None and buf:
        cues.append((start, " ".join(buf)))
    return cues


def dedupe(words, new):
    """Append only the part of `new` that is not already the tail of `words`."""
    limit = min(len(words), len(new))
    for k in range(limit, 0, -1):
        if words[-k:] == new[:k]:
            return new[k:]
    return new


def stamp(t):
    t = int(t)
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def blocks(cues):
    out = []
    words = []
    start = None
    for t, text in cues:
        new = text.split()
        if not new:
            continue
        if start is None:
            start = t
        words.extend(dedupe(words, new))
        span = t - start
        ends_sentence = words and words[-1][-1:] in ".!?"
        if (span >= MIN_BLOCK and ends_sentence) or span >= MAX_BLOCK:
            out.append((start, " ".join(words)))
            words = []
            start = None
    if words:
        out.append((start or 0.0, " ".join(words)))
    return out


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: vtt-to-cues.py <file.vtt>")
    cues = parse(sys.argv[1])
    if not cues:
        sys.exit(1)
    parts = blocks(cues)
    if not parts:
        sys.exit(1)
    print("\n\n".join(f"**{stamp(t)}** · {text}" for t, text in parts))


if __name__ == "__main__":
    main()
