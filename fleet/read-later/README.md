# read-later feeds

Fills the owner's Obsidian reading queue from the two places he already saves
things: YouTube Watch Later and X bookmarks. The queue itself is plain markdown
in `~/work/self/notes-vault/Reading/Inbox/`, one note per item, and
the dashboard reads it at http://100.64.0.2:3456/reading.

Nothing here deletes. Un-bookmarking a tweet or clearing Watch Later leaves the
note where it is.

## Files

| File | What it does |
|---|---|
| `export-dia-cookies.py` | Decrypts Dia's cookie jar into a Netscape `cookies.txt`. Never prints values. |
| `lib.sh` | URL normalization, the dedupe index, the note writer, the tweet render and the thread walk. Sourced by the feeds. |
| `youtube-wl.sh` | Watch Later playlist to notes (`kind: video`, `fetched: false`). |
| `x-bookmarks.sh` | X bookmarks to notes (`kind: tweet`, body already complete). |
| `backfill-kind.sh` | Idempotent: adds `kind:`/`via:` where missing and corrects a wrong `kind`. |
| `enrich-tweets.sh` | Rewrites tweet bodies from fxtwitter. Skips notes marked `enriched: true`. |
| `pdf-to-md.py` | A PDF as reading markdown, clipper-style: `pdftohtml -xml` font sizes give h2/h3 headings, bold run-ins, captions; links kept (internal ones jump to the page mark); paragraphs reflowed, running headers and page numbers dropped, `<span class="rl-pg" id="rl-page-N">` marks. `--assets <dir>` also keeps the figures (below). Falls back to a pdftotext reflow (`--plain`). `--title` picks the title. Called by `add.sh` for documents. |

| `enrich-tweets.sh` | Rewrites tweet bodies from fxtwitter. Skips notes marked `enriched: true`; `--threads` re-runs the thread step. |
| `pdf-to-md.py` | A PDF as reading markdown, clipper-style: `pdftohtml -xml` font sizes give h2/h3 headings, bold run-ins, captions; links kept (internal ones jump to the page mark); paragraphs reflowed, running headers and page numbers dropped, `<span class="rl-pg" id="rl-page-N">` marks. Falls back to a pdftotext reflow (`--plain`). `--title` picks the title. Called by `add.sh` for documents. |
| `vtt-to-cues.py` | WebVTT to timestamped transcript paragraphs. Called by the skill's `add.sh`. |
| `prefetch.sh` | Fetches bodies for the newest unread notes that have none, on a budget. |
| `autotag.sh` | Tags untagged notes with a headless Sonnet call against the taxonomy. |
| `tagger-prompt.md` | The tagger's instructions, fed verbatim. Shared with the by-hand agent. |
| `sync.sh` | Runs them all in order, isolated, one summary line to the log. |
| `com.example.read-later-sync.plist` | Hourly launchd job. |

Full article and transcript fetching is NOT here. It lives in
`~/.claude/skills/read-later/add.sh` (defuddle for articles, yt-dlp for
transcripts, fxtwitter for tweets, pdftotext for documents), which the dashboard shells out to on first
open of an unfetched note and for the "Paste a link" box. One fetch
implementation, not two.

## The cookie file

`~/.config/read-later/cookies.txt`, mode 0600, rewritten at the start of every
sync. It is never committed, never logged, and never written anywhere under
`~/Downloads`. If a feed starts failing with an empty result, the usual cause is
that the owner signed out in Dia; signing back in and re-running `sync.sh` fixes it.

## Running it

```bash
cd ~/.claude/plugins/local/kushbot/fleet/read-later
./sync.sh                 # what launchd runs: cookies, then both feeds
./sync.sh --seed          # first-run sizes: 50 videos, 300 tweets
./youtube-wl.sh           # one feed on its own
./x-bookmarks.sh
./enrich-tweets.sh        # rebuild tweet bodies from fxtwitter (--force redoes all)
./enrich-tweets.sh --threads   # the thread step over notes with no thread yet
./backfill-kind.sh        # repair kind/via on notes written by other tools
tail -5 ~/kush/logs/read-later-sync.log
```

The hourly job:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.read-later-sync.plist
launchctl kickstart -k gui/$(id -u)/com.example.read-later-sync   # run it now
launchctl print gui/$(id -u)/com.example.read-later-sync | head
```

The plist in this directory is the source of truth; `~/Library/LaunchAgents/` holds
a copy. It runs session-attached (`LimitLoadToSessionType: Aqua`) because
agent-browser needs a real login session, and its launchd output goes to
`~/kush/logs/`, never under `~/Downloads` (TCC blocks launchd there).

## Tags

The taxonomy lives at `Reading/tags.md` in the vault and is kc's: a table of
tag, meaning and count. `autotag.sh` reads it, sends it with a batch of up to
twenty untagged notes to `claude -p` on Sonnet with no tools and no MCP, and
writes back one to four tags per note. It prefers the tags already in the table
and may add at most two new ones per batch, appended as rows with a placeholder
meaning for kc to fill in. Counts are recounted from the inbox rather than
incremented, so the table stays right even if a run dies halfway.

The capture path (`add.sh`) fires it for the single new note in the background,
so nothing waits on a model call. The hourly sync does at most five calls. A
failed call leaves notes untagged and says so in
`~/kush/logs/read-later-tags.log`; nothing else is blocked by it.

```bash
./autotag.sh          # up to 5 calls
./autotag.sh --all    # the whole backlog
./autotag.sh --file /path/to/note.md
```

## Adding a host to the exporter

The exporter takes host substrings as trailing arguments and exports only
matching cookies:

```bash
python3 export-dia-cookies.py \
  "$HOME/Library/Application Support/Dia/User Data/Profile 1" \
  "$HOME/.config/read-later/cookies.txt" \
  youtube.com google.com x.com twitter.com news.ycombinator.com
```

Add the new host to the same list in `sync.sh` so it survives the hourly
rewrite. For a job that needs the cookies in a browser rather than in curl or
yt-dlp, copy the pattern at the top of `x-bookmarks.sh`: open the origin first,
then set each cookie individually with `agent-browser cookies set` (the bulk
`--curl` import rejects the `httpOnly`/`secure` fields).

## Notes on the two feeds

**YouTube.** Transcripts are stored as `**0:36** · one paragraph` blocks, which
is what lets the reader follow the player and seek by tapping a paragraph.
`vtt-to-cues.py` does that conversion: it strips caption markup, undoes the
rolling repetition in auto-generated subtitles, collapses the `&nbsp;` runs that
were showing up as double spaces, and merges cues into blocks of roughly half a
minute that prefer to end on a sentence. Notes fetched before this exists keep
their flat transcript and simply do not sync.

`yt-dlp --flat-playlist -J` on the `WL` playlist. Playlist order is
newest-added first, so `--seed` takes the first 50 and the hourly run takes the
first 60. That window is deliberate: Watch Later holds a 261-entry backlog, and
an uncapped hourly scan tips all of it into the queue on its first run. Flat entries carry no upload
date, so `published:` is left empty and filled in only if a later fetch has it.

**X.** The page is used for permalinks only; every body comes from
`api.fxtwitter.com`, because the bookmarks list renders the collapsed "Show
more" text and drops the quoted tweet entirely. fxtwitter gives the full text,
the quote, the media and the real timestamp, and the note records
`enriched: true` so `enrich-tweets.sh` can be re-run cheaply. If fxtwitter
fails the scraped text is used and the note is simply left unenriched. A handful
of media-only tweets return 200 with no text and no media at all; those keep
their placeholder body and are named in the log.

agent-browser runs in its own `read-later-x` session with `--restore` off.
`x.com/i/bookmarks` currently redirects to `/i/history` where Bookmarks is a tab,
so the script selects that tab if it is not already active. The list is
virtualized (about six articles in the DOM at a time), so it harvests after every
scroll and accumulates, stopping after four scrolls with nothing new. Tweet text
is read by walking the DOM nodes rather than `innerText`, which splits URLs
across lines.

## Listen (2026-09-11)

Text to speech for anything that is words on a page: articles, documents with a
text layer, and X's long-form posts. Videos already have a voice and a plain
tweet is two lines, so neither offers it. A rendering is made once and kept, so
the second listen costs nothing.

`dashboard/pages/mac/reading-audio.ts` holds all of it; `reading.ts` only draws
the control and hands the routes through.

**Where the audio lives.** `Reading/Files/audio/<note stem>.<voice>.mp3` next to
the PDFs, with a `.json` sidecar carrying provider, voice, label, seconds,
characters, the ISO timestamp, and `cues` — one `{i, t}` per spoken paragraph.
The note's frontmatter grows one key, `audio: [aura-2-thalia-en, priya]`,
listing what has been rendered; nothing else in the note is touched. A note
whose title contains a character an asset route must refuse is slugged, with six
hex of the original appended so two titles cannot flatten onto one file.

**Voices**, in the order the wheel offers them, last-used preselected:

| id | label | model |
|---|---|---|
| `aura-2-thalia-en` | Thalia (Deepgram) | Aura-2, the voice Guru speaks with |
| `aura-2-neptune-en` | Neptune (Deepgram) | Aura-2, a side-project narration voice |
| `aura-2-orpheus-en` | Orpheus (Deepgram) | Aura-2, Kush on Telegram |
| `priya` | Priya (Sarvam) | bulbul:v3 |
| `anushka` | Anushka (Sarvam) | bulbul:v3 — **not on the v3 roster, fails** |
| `abhilash` | Abhilash (Sarvam) | bulbul:v3 — **not on the v3 roster, fails** |

Sarvam retired `bulbul:v2` and its speaker list with it. Anushka and Abhilash
were v2 speakers; v3 answers with the roster it does have (aditya, ritu,
ashutosh, priya, neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita,
shreya, ratan, varun, manan, sumit, roopa, kabir, aayan, shubh, advait, anand,
tanya, tarun). The two are still listed because they are the voices the owner
asked for; swapping them for two off that roster is a one-line edit to `VOICES`.

Deepgram requests carry `mip_opt_out=true`, keeping his reading out of the
model-improvement program, the same setting a side-project narration locked in.

**Cost**, shown before anything is spent. Aura-2 is $0.030 per 1,000 characters
pay-as-you-go (deepgram.com/pricing, 2026-09-11); bulbul:v3 is ₹30 per 10,000
(docs.sarvam.ai/api-reference-docs/pricing), quoted in rupees so no exchange
rate is baked in. Length assumes 15 characters a second of speech, which lands
within a few percent: a 8,831-character article estimated 10 min and rendered
9:31. Over 30 minutes the page asks first and offers the whole text or the
first 30 minutes.

**The text it reads** comes from the rendered body, not the markdown — the same
HTML the reader shows. That is what keeps the cues honest: a cue's `i` is the
index of an element in

```
.rl-body .md p, .rl-body .md h2, .rl-body .md h3, .rl-body .md li
```

which the DOM returns in document order, and the preparer counts those same
four tags off the same HTML. Change the selector in `reading.ts` and change
`SPOKEN` in `reading-audio.ts` with it. Along the way the H1 goes (it is not one
of the four), page marks go (`page 14` mid-sentence is not reading), raw URLs go
while the words that linked to them stay, and a heading gains a full stop so it
is spoken as its own sentence. Paragraphs are grouped into chunks up to each
provider's per-request ceiling (Deepgram 1900, Sarvam 480) and never split
mid-sentence.

**Where a sentence ends** is one rule in one file,
`dashboard/static/reading/sentences.js`. Three pieces of code have to agree
about it to the sentence: the chunker cuts only where it says a sentence ends,
the aligner numbers a block's sentences with it, and the reader wraps those same
sentences in spans with it. A cue says "block 12, sentence 3" and means nothing
if any two of them count differently. The file is imported by the server and
served to the browser as one more chrome script. It knows about "Mr.", "e.g.",
decimals, ellipses mid-sentence, and dotted acronyms (`U.S.`, `Ph.D.` — every
piece between the dots is a letter or two, which needs no list); it splits only
when a stop is followed by whitespace and something that can open a sentence.

**Sentence times, for real.** Neither provider gives any. Deepgram's TTS answers
`/v1/speak` with the audio and nothing else, and its WebSocket sends
`Metadata` / `Flushed` / `Cleared` / `Warning` with no word or character time in
any of them — there is no timestamps, alignment, marks or viseme feature in
Aura-2 (developers.deepgram.com/docs/tts-websocket and
/reference/text-to-speech-api, read 2026-09-11). Sarvam's `/text-to-speech`
answers with base64 wav and a request id (docs.sarvam.ai, same day). So the
times are recovered from the finished mp3:
`dashboard/pages/mac/reading-align.ts` sends it to Deepgram's own speech to text
(`/v1/listen`, nova-3, `punctuate=true`, `smart_format=false` so numbers come
back as they were spoken) and aligns the word sequence it gets against the words
we asked for, with a banded Needleman-Wunsch that tolerates "30" arriving as
"thirty" and "$100" as "one hundred dollars". Both Thalia renderings align 93%
of their words; a clip cut at a cue opens on that sentence's first word with no
lead-in at all. It costs $0.0043 a minute of audio (deepgram.com/pricing,
2026-09-11, pre-recorded nova-3 monolingual pay-as-you-go — the $0.0077 on that
page is streaming). The 67-minute piece cost $0.29 to align, against nearly two
dollars to render, and took six seconds.

A render aligns itself at the end. Anything rendered before this existed is
aligned in place with the route below, which does not touch the mp3. If the key
is missing or the alignment comes back thinner than 60% matched, the cues stay
as they were: each chunk's ffprobe length spread across its characters, now at
sentence resolution as well. A rendering is never left without cues.

The sidecar gained `v`. `v1` was one `{i, t}` per paragraph; `v2` is one
`{i, s, t}` per sentence plus `aligned`, `alignedAt` and `matched`. The reader
still reads `v1` and stays at paragraph resolution for it.

**Routes.**

| Route | What |
|---|---|
| `POST /api/reading/audio/estimate` | `{file, voice}` → characters, minutes, cost, what aligning would add |
| `POST /api/reading/audio/render` | `{file, voice, limitSeconds?}` → queues a job, returns at once |
| `POST /api/reading/audio/align` | `{file, voice}` → sentence times for an mp3 that already exists, sidecar rewritten in place, no re-render |
| `POST /api/reading/audio/at` | `{file, voice, seconds}` → where he stopped, into the note's `audio_at` |
| `GET /api/reading/audio/state?f=&voice=` | queued / running with `done` of `total` / ready / failed with the provider's own message, plus everything saved |
| `GET /reading/audio?f=<stem>.<voice>.mp3` | the audio, with Range → 206 so Safari can scrub; `&download=1` for the Download link |
| `GET /reading/audio/cues?f=<stem>.<voice>.json` | the sidecar |

**The job.** In-process, one at a time per note, chunks three at a time, and
detached from the request that started it — closing the tab does not stop it,
and reopening the note picks the progress back up. Everything is built in a
temp dir; the mp3 and its sidecar are moved into `Reading/Files/audio/` together
at the end, so a failed render leaves nothing behind and a half-written file is
never mistaken for a rendering. A provider error fails the job with the
provider's sentence intact, because "insufficient credits" and "voice not found"
want different things done about them.

**The player** is ours, pinned above the bottom bar and never over it (the bar's
height is measured, since an error line or a confirm changes it). The `<audio>` element
is still the engine and still what the browser hands to the lock screen, but it
is hidden: Safari's own control is a scrubber and a volume slider, and what he
does on a walk is jump back fifteen seconds, step to the sentence he missed, and
change the speed. So: previous sentence, back 15, play/pause, forward 15, next
sentence, all on 44px targets; a scrubber with elapsed and remaining; the speed
chips 1x / 1.25x / 1.5x / 2x, remembered; the voice; and Close, which puts the
bar away and hands the body back exactly as it was found. The last three share
one line that never wraps: the voice reads `Thalia · 10 min`, or
`Thalia · 10 min · at 12:34` where the resume point is known, and the name is the
only part allowed to ellipse. The provider and the date it was made are dropped
here — they are on the saved row in the Listen panel, a thumb's width above.

**Media Session** carries the title, the voice as the artist,
`/static/reading-icon-512.png` as the artwork, and handlers for play, pause,
seek, seek-to and previous/next sentence, so the lock screen and the AirPods do
the right thing. That is where he listens.

**The sentence being spoken** is wrapped on the page while something plays: the
text nodes of each block are walked, split on the shared rule, and each piece
goes in a `<span class="rl-sent" data-i data-s>`. A sentence that crosses a link
or an existing `<mark>` becomes several spans sharing the same two numbers and
lights up as one. The paragraph keeps its hairline in `--accent`; the sentence
carries a tint. Nothing is wrapped until a rendering is playing, and Close
unwraps and normalises, so the body the selection, the highlight pill, the link
press and the block indexing all work against is byte for byte the one the
server sent. A highlight made mid-playback rewraps rather than being understood.

**Scrolling follows it** — a third from the top, smooth — and lets go the moment
a scroll arrives that it did not cause. "Back to sync" is the way back, and
scrolling back to the line resumes following without being asked. The same
follower moves a video's transcript under its player, so there is one of it and
not two. It is gated on **Scroll to sync**, the first switch in the sheet under
the three dots in the bar.

**Settings** are site-wide, in `dashboard/static/reading/settings.js`, loaded
before every page script. One JSON object in `localStorage` under `rl-settings`,
and a contract the other scripts are written against:

```js
RLSettings.get(key, fallback)   // the value, the fallback, or the default
RLSettings.set(key, value)      // writes it and tells everyone listening
RLSettings.on(key, fn)          // fn(value) now, and again on every change
```

`on` firing once immediately is the point: a consumer says what to do with the
value in one place and never reads it separately at startup. Changes reach other
open tabs through the `storage` event.

**Where he stopped listening** is kept twice. `rl-audio-pos:<url>` in
`localStorage` is the fine pointer for this browser; `audio_at: [voice, seconds]`
in the note is the coarse one every device can see, written once a minute while
the voice runs and again whenever he leaves — pause, Close, the tab going away.
The saved row says "at 12:34" and Play starts there; the further of the two
wins. And because a page served from the worker's cache can be older than the
rendering it describes — he listened to twenty minutes of Hyperliquid, came
back, and was offered to make audio that already existed — the reader re-asks
the server for the saved rows on load instead of trusting the HTML that arrived.

**Keys.** `l` opens Listen, space plays and pauses, `,` and `.` step to the
sentence before and after. Tapping any sentence reads from there.

**Needs** `ffmpeg` and `ffprobe` at `/opt/homebrew/bin`, and the keys at
`~/.secrets/deepgram-api-key.env` and `~/.secrets/sarvam-api-key.env`. The same
Deepgram key does the alignment. The reference request shapes are
`~/.claude/skills/voice-bridge/tts.sh`.

```bash
# what it would cost, without spending anything
curl -s localhost:3456/api/reading/audio/estimate -X POST \
  -H 'Content-Type: application/json' \
  -d '{"file":"Some note.md","voice":"aura-2-thalia-en"}'

# sentence times for a rendering that already exists; the mp3 is not touched
curl -s localhost:3456/api/reading/audio/align -X POST \
  -H 'Content-Type: application/json' \
  -d '{"file":"Some note.md","voice":"aura-2-thalia-en"}'
# → {"ok":true,"matched":0.933,"sentences":101,"seconds":570.9}

# Range must answer 206, or Safari will not seek
curl -sI -H 'Range: bytes=0-99' 'localhost:3456/reading/audio?f=Some%20note.aura-2-thalia-en.mp3'
```

## Threads (2026-09-11)

A saved post that sits in a chain of its author answering himself is one piece
of reading, so the note carries the whole chain. The body keeps its shape — h1,
then the posts as blockquotes with media as before — and each post gets a quiet
`**1/7**` marker above it. Frontmatter gains `thread: <count>`, plus
`thread_root: <id>` when the saved post is not the first one. `enriched: true`
still means "the body came from fxtwitter", so nothing about re-running changed.

One implementation, in `lib.sh`, inside `rl_tweet_render` — so
`x-bookmarks.sh`, `enrich-tweets.sh` and the skill's `add.sh` all get it from
the same place, and a new capture arrives unrolled.

**How the chain is found.** Two halves, and only one of them is easy:

- **Up** is fxtwitter. Every reply carries `replying_to` (the handle) and
  `replying_to_status` (the id), so from any post we climb to the root at one
  cheap call per hop, signed out, and stop the moment the parent is somebody
  else — a reply to another person is a conversation, not a thread.
- **Down** needs the status page. Nothing public returns a tweet's *children*.
  Checked on 2026-09-11: fxtwitter and vxtwitter have no such field and no
  thread route (`/status/<id>/thread` is the same single tweet);
  `cdn.syndication.twimg.com/tweet-result` returns the tweet and its `parent`
  only; `syndication.twitter.com/srv/timeline-profile` answers 429; and every
  nitter mirror still answering (xcancel, tiekoetter, lightbrd, nitter.space)
  sits behind a bot check. So down reads the conversation out of the signed-in
  `read-later-x` agent-browser session, scroll-and-harvest like the bookmarks
  list, and then *verifies* every candidate against fxtwitter: a post is
  appended only when fxtwitter says it is this author replying to the post
  before it. That keeps other people's replies and X's "discover more" out.

**Down is currently unavailable**, and that is survivable by design: x.com
answers a cookie-less browser with 403, and `auth_token` has been missing from
the Dia export since 2026-09-09 (the same reason `x-bookmarks.sh` has been
failing). When the page yields nothing, the thread is whatever the up-walk
found and the note keeps everything it had — no note is ever left shorter than
it was. The first failure of a run writes one line to the detail log and stamps
`$TMPDIR/read-later-x-down`, which suppresses the attempt for half an hour so a
capture from Telegram does not spend fifteen seconds proving it again. Sign back
in to X in Dia, re-run `sync.sh`, and the down half starts working with no code
change; `./enrich-tweets.sh --threads` then picks up the posts below.

Knobs, all env: `RL_THREADS=0` turns the step off, `RL_THREAD_BROWSER=0` keeps
it to the up-walk, `RL_THREAD_MAX` caps the chain (25), `RL_X_SESSION` names the
browser session.

```bash
./enrich-tweets.sh --threads           # notes with no thread yet (cheap re-run)
./enrich-tweets.sh --threads --force   # including the ones already known
RL_THREAD_BROWSER=0 ./enrich-tweets.sh --threads    # no browser at all
grep -c '^thread: ' ~/work/self/notes-vault/Reading/Inbox/*.md | grep -v ':0'
```

The backfill of the 182 saved tweets (2026-09-11, up-walk only) found **8
threads, 22 posts, 2.75 posts each** — from two posts up to four. In all eight
the saved post was somewhere inside the thread, never the first one, which is
exactly the shape the up-walk can see; a bookmark that IS the root still needs
the down half. One note could not be re-fetched at all
(`ctbeiser/1367879838145540098`, a 2021 tweet that is gone) and kept its body
untouched; 173 notes came back byte-for-byte identical.

## Documents (2026-09-11)

A link whose path ends in `.pdf`, or that the server answers with
`application/pdf`, becomes `kind: document`. `add.sh --full` keeps the file at
`Reading/Files/<note stem>.pdf` (the vault sees it; Obsidian opens it), renders
page one to `Reading/Files/.thumbs/<stem>.png`, and writes the text layer through
`pdf-to-md.py` as the body. Frontmatter gains `pdf:` (the file name), `pages:`,
and `author:`/`published:` when the PDF metadata has them. The dashboard serves
the copy at `/reading/file?f=` and the thumbnail at `/reading/thumb?f=`; the
reader embeds the file on wide screens and shows the cover plus a link into the
system viewer on a phone, with the text underneath for highlights and search.
A scan with no text layer is still a document with an empty body. Only PDF for
now; another format means another branch in `add.sh` and a body extractor here.

### Figures

`pdf-to-md.py --assets <dir>` lets pdftohtml write the page images into that
directory, and puts the ones that are figures back into the text at the height
they sat on the page. `add.sh` passes `Reading/Files/.assets/<stem>/`, one
directory per document, and the body links each figure as
`![alt](/reading/asset?f=<stem>/<file>)`, which the dashboard serves from there.
Without the flag no image is written at all and the body is what it was before.

Most of what a PDF embeds is not a figure, so three rules decide:

- **the same bytes on three or more pages** is a letterhead, a watermark or a
  section motif, not a figure;
- **under 120 units on either side** is a rule or a wordmark — unless it still
  covers 2.5% of the page, which is what a wide, short banner figure does;
- **over 85% of the page** is the page's own background.

Anything dropped is deleted from the assets directory, so the directory holds
exactly what the note shows. The caption directly under a figure — the small
tier, or a line that opens `Figure 3.` / `Table 2:` — becomes its alt text and
stays a caption as well; an uncaptioned one gets "Figure on page N".

On Anthropic's September 2026 report that is 60 figures kept out of 61 embedded
images, the one drop being the cover wordmark. On an arXiv paper
(`1911.01547`), all 12, each with its own caption.

The reader has two views for a document, remembered across documents: **Read**
(default) is the extracted text as an article; **PDF** embeds the file with the
text under it, and has a Fullscreen control (`f`; `v` flips the view). To redo
a document's body after an extractor change, run `pdf-to-md.py` on the file in
`Reading/Files/` and replace everything after the `# ` heading; frontmatter and
`## Highlights` / `## Notes` stay.

## Length and tag chips, and the URL (2026-09-11)

Under the kind and status rows the list has a third row of chips: three lengths
on the left, then the tags the visible rows actually carry.

**Length.** `<5m`, `5-20m`, `>20m`, from the `readMin` a note already knows. A
tweet is always under five minutes; its `readMin` is 0 because counting the
words of a tweet is not worth trusting, not because its length is unknown.
Anything else at 0 -- an article that was never fetched, a video with no
duration -- has no length at all, belongs to no bucket, and shows only when no
length chip is pressed. Filing those under `<5m` would be a guess, and half the
guesses would be wrong.

**Tags.** Counted off the rows on the page (`data-tags`), not off
`Reading/tags.md`, which still lists tags nothing in the queue carries. Kind and
status decide the pool and the counts; the search box and the tag itself do not,
so the row does not reshuffle under the finger. The top eight by count are
shown, `more` opens the rest, and the tag in use stays on the row even when it
falls out of the top eight. `reading` and `starred` are structural and never
appear. One tag at a time; tapping the pressed chip clears it, and so does
tapping the pressed length.

**The URL.** Everything he is looking at goes into the query string with
`history.replaceState`, defaults left out:

    /reading?kind=video&status=unread&tag=trading&len=short&q=words

`kind` = all|article|video|tweet|document, `status` = unread|starred|done,
`len` = short|mid|long, `q` = the search box, tokens and all. On load any one of
the five keys hands the whole state to the URL and the stored filter is ignored;
a bare `/reading` (the `?t=` cache-buster counts as bare, and is dropped on the
first render) keeps using what was last set here. The same state is written to
`localStorage["rl-filter"]`, which is what the reader reads: `/api/reading/list`
takes `kind=` `status=` `tag=` `len=` so next and previous in the reader walk
the same narrowed queue the list was showing.

## Progress (2026-09-11)

How far into something he is, kept in the note rather than in a browser, so the
list can show it and the phone and the Mac agree about it. Two frontmatter keys,
written together:

```
progress: 42
progress_at: 2026-09-11T15:20:04
```

**The furthest point wins.** `POST /api/reading/progress {file, percent}` raises
the number and never lowers it, which is what makes it safe to report from three
places at once on however many devices. Exactly two things take it back:
`status: unread` clears both keys, and `{percent: 0, reset: true}` does the same
on purpose. Done (`status: read`) sets it to 100 — one write says both, in
`applyStatus()`, so the Done button in the reader and the done/unread word on a
row already do the right thing. Skipped is left alone: deciding not to read
something is not a claim to have read it. A write that would not move the number
does not touch the file at all.

**What counts, per kind.**

| Kind | The measure |
|---|---|
| article, tweet, document in Read view | the bottom of the window against the bottom of `.rl-body` — his highlights, his notes and the bar underneath are not something still to read |
| video with a synced transcript | the YouTube player's `getCurrentTime()` over `getDuration()`, off the existing `tick()` |
| anything while Listen is speaking | the playhead over the audio's length |

Three cases measure nothing rather than guess: a body shorter than the window
plus 200 px (a tweet that fits on one screen has no "how far in"; Done is what
marks that read), a document being read as a **PDF** (the paging happens inside
a frame this page cannot see into), and a video with no synced transcript, which
is a plain embed with no API to ask. Opening something never writes: only a
scroll, a playhead or an explicit Done does.

**The cadence** is one POST every five seconds at most, plus one on `pagehide`
and on `visibilitychange` to hidden — that last one through `navigator.sendBeacon`,
with a `keepalive` fetch behind it, because the write that matters is the one
made while the tab is being taken away. Nothing goes in
`read-later-actions.log` for an ordinary progress write; a write every five
seconds is not an event, and `progress_at` is the record of when. A reset does
get a line.

**Resume.** `localStorage["rl-pos:<file>"]` is still the fine-grained pointer:
the exact pixel he stopped at *on this device*. The note carries the furthest
point *on any* of them. The pixel wins unless the note is more than two points
ahead of it, and then the reader jumps to the note's position and says
**Resume at 42%** in a hairline strip across the top, which takes itself away
after six seconds — the jump has already scrolled the byline off the screen, so
the line has to be fixed to be seen at all. A video seeks to its point on
`onReady` and is paused there rather than played. Only while the note is unread,
the same rule the scroll pointer always had.

**Where it shows.**

- The reader: a 2 px `--accent` hairline across the very top, on every kind, and
  in the byline **"12 min left"** in place of "31 minute read" while progress is
  between 1 and 99 (from `readMin` and the percentage; a video's `readMin` is
  its duration, so the same arithmetic gives "8 min left").
- A row: the same hairline under the title, `--accent` on `--border`, and
  "40% read" in the meta line. Both are painted from the row's own
  `data-progress`, so marking something done or unread repaints them without a
  reload. On a phone the meta ellipsises as it always has, and the percentage is
  what falls off the end; the hairline is still there.
- A status chip, **In progress**, beside Unread / Starred / Archive: unread
  items with a progress between 1 and 99. Key `i`, URL `?status=progress`, and
  `/api/reading/list?status=progress` for the reader's next and previous.

`progress` and `progressAt` are on `Note`, so they are in every list JSON.

## Saving from Safari (2026-09-11)

`GET /reading/add?url=<link>&tags=a,b[&format=json]` on the Mac dashboard writes
the note with its title at once and fetches the body in the background. Two
callers: an Apple Shortcut in the Share Sheet ("Save to Reading": Receive URL,
Ask for Input for tags, Get Contents of that URL with `format=json`, Show
Notification with the `message` key) and a Dia/Safari bookmarklet that opens the
same address without `format=json` and lands on a small Queued page. Dedupe in
`add.sh` matches on the normalised address (`rl_norm_url` from lib.sh), so
`www.` and bare hosts are one note.


## Actions on a link inside an item (2026-09-11)

He reads an arXiv abstract page and wants the paper. He reads a tweet and wants
the piece it points at, later. Both used to mean leaving the reader, finding the
link again in a browser, and saving it from there.

**The gesture.** In `.rl-body`, a right-click on a link (desktop) or half a
second of stillness on one (touch) raises the *selection pill* over that link
with three actions: **Queue**, **Replace**, **Open**. It is the same `.rl-pill`
element, the same `placePill()` and `pillButtons()` the Highlight actions use —
one pill, whatever it is currently about.

The rule that keeps it from fighting the Highlight pill: **a gesture that has
produced a text selection belongs to the selection.** On the desktop a
right-click with something selected falls through to the browser's own menu (he
is copying or searching), and only a right-click on nothing selected is read as
being about the link — so the native menu is suppressed exactly when the pill
opens, never otherwise. On touch the 500 ms timer is cancelled by any movement
over ~10 px, by lifting, and by a scroll; when it does fire it checks the
selection first, so the long press Safari turned into a word selection still
raises Highlight as it always did. `-webkit-touch-callout: none` on
`.rl-body a` keeps iOS from putting its own link sheet over the pill, and the
tap that ends a long press is swallowed in the capture phase so it neither
follows the link nor counts as the tap-outside that closes the pill.

**Queue** posts the link to the existing `POST /api/reading/add` with no tags
and stays on the page: he asked for it later, not now. The pill turns into
`Queueing…` and then `Queued: <title>` (or `Already queued: …`), and hides
itself a couple of seconds later. A failure lands in the bottom bar's error
line like every other write.

**Replace** — `POST /api/reading/replace { file, url }` — makes this note about
a different address instead of making a second note:

1. `source:` and `site:` take the new link, `fetched:` goes back to `false`.
2. `kind:` is set the way `add.sh` would: youtube → `video`, x/twitter →
   `tweet`, a `.pdf` path *or* an `application/pdf` content type (one `HEAD`,
   8 s budget) → `document`, otherwise `article`.
3. Dropped, because they described the old thing: `pdf:`, `pages:`,
   `duration:`, `transcript:`, `body:`, `fetch_attempts:`, `published:`,
   `author:`. The last four include the give-up markers, which are a verdict on
   a fetch that has not been attempted for this link yet.
4. Kept, because they are his decisions about this row in the queue: `added`,
   `status`, `rating`, `tags`, `via`, `clipped` — and `## Highlights` /
   `## Notes`.
5. `replaced:` records the address the note used to hold, so nothing is lost.
6. The `# ` heading goes. `add.sh`'s upgrade path looks the title up again when
   the H1 is missing or is just the hostname, so the note renames itself in the
   reader without the file being renamed.
7. `startFetch()` — the same one the reader uses for anything unfetched — runs
   behind the response. The client reloads and gets the ordinary "Fetching…"
   page with its poll.

The file keeps its name. Renaming would break the vault's links to it and lose
the reader's saved scroll position, so the name goes stale until he tidies it in
Obsidian; the reader shows the new title either way.

One thing this needed from the fetch path: `add.sh`'s upgrade branch keeps the
frontmatter and throws the whole body away, which would have taken his
highlights and notes with it. `fetchBounded()` now lifts the marginalia out
before each `add.sh` pass and merges it back after (`keepMarginalia()` /
`putMarginaliaBack()`), which is also the right behaviour for any re-fetch of a
note he has already marked up.

**The arXiv line.** When a note's source is `arxiv.org/abs/<id>` — or its body
carries that link and the note is not already a document — one quiet line sits
under the byline: *This is the abstract page. Replace with the PDF*, pointing at
`arxiv.org/pdf/<id>`. It is a real link, so it still works with JavaScript off;
the click runs Replace instead of navigating.

**The bar.** **Replace…** opens an inline row with a URL field, for a link that
is not in the body to right-click. Same shape as the Delete confirm;
`bar.dataset.confirm` is `"0" | "del" | "rep"` rather than a boolean. Both words
live in the sheet now (below), and both still ask their question in the bar: the
handler closes the sheet and then sets `data-confirm`, because the answer wants
to be where his thumb already is.

`?` documents both gestures in the Reader column. Every replace is one line in
`~/kush/logs/read-later-actions.log`: `replace <file> <old> -> <new>`.

## Offline (2026-09-11)

The queue is 250 unread pieces, about 7 MB of text, and the one place he
actually wants it is a plane. `/reading` now keeps a copy of itself.

### The front door

Safari refuses to run a service worker over plain http, so the Tailscale IP is
not enough. The dashboard also listens on loopback, and Tailscale Serve puts an
https name in front of it:

```bash
tailscale serve --bg --https=8443 http://127.0.0.1:3456
# → https://laptop.TAILNET.ts.net:8443/reading   (tailnet only)
tailscale serve status          # what is published
tailscale serve --https=8443 off   # take it down
```

Serve cannot proxy to the machine's own Tailscale IP, which is why the target is
`127.0.0.1:3456` rather than `100.64.0.2:3456`.

Both addresses keep working and both are the same pages:

| Address | Service worker | Writes |
|---|---|---|
| `http://100.64.0.2:3456/reading` | no — plain http is not a secure context | always live |
| `https://laptop.TAILNET.ts.net:8443/reading` | yes | live, and offline once phase 8 lands |

Nothing about the http origin changed. `isSecureContext` is false there, so the
registration is simply never attempted and every offline call is a no-op.

### Add to Home Screen

1. Open `https://laptop.TAILNET.ts.net:8443/reading` in Safari on the
   phone (on the tailnet — Tailscale on and connected).
2. Share → **Add to Home Screen** → Add. The name comes from the manifest:
   *Reading*. The icon is the dog-ear.
3. Open it from the Home Screen once while online. It runs standalone, with no
   Safari chrome, and that first run installs the worker and warms the queue.

The manifest matters for more than the chrome: Safari evicts a plain website's
storage after seven days without a visit, and an installed web app is exempt. A
queue that quietly emptied itself between trips would be worse than no queue.

### What is cached, and how

`/reading/sw.js` is served with `Service-Worker-Allowed: /reading`, so its scope
is `/reading` rather than `/reading/` — the list lives at `/reading` exactly,
with no trailing slash, and would otherwise be outside its own worker.

| Request | Strategy | Cache |
|---|---|---|
| `/reading`, `/reading/item?f=` (navigations) | stale-while-revalidate — show the copy, refresh behind it, say so if the new one differs | `rl-pages-v1` |
| `/reading/static/*`, `/reading/manifest.webmanifest` | cache first; precached on install | `rl-shell-v1-<build>` |
| `/reading/asset`, `/reading/thumb`, `/reading/img`, `/reading/icon.svg` | cache first | `rl-media-v1` |
| `/reading/file` (PDF), `/reading/audio`, `/reading/audio/cues` | the kept copy if there is one, otherwise the network | `rl-keep-v1` |
| `/api/reading/*`, `/reading/add` | network only, never cached | — |
| everything else | not intercepted | — |

A page is filed under a normalised address: every `/reading?kind=…&tag=…` is one
entry, because the list ships every note and does its filtering in the browser,
and a reader page is its `f=` and nothing else. That is also what keeps the
`?t=` cache-busters from filling the cache with duplicates.

**Warming.** On the list, when the browser says it is idle, the worker fetches
the newest 30 unread pieces *that already have a body*, one at a time, and the
handful of pictures in each. Warming an unfetched note would start 30 `add.sh`
runs behind his back and cache 30 "Fetching…" pages under the addresses of the
pieces he wanted.

**Cross-origin pictures.** 41 tweets carry photos from `pbs.twimg.com` and two
articles pull theirs off Substack's CDN. Fetched cross-origin those can only be
cached *opaquely*, and an opaque response is charged against the origin's quota
at a padded several megabytes each whatever its real size. `<img src>` in a
rendered body is rewritten to `/reading/img?u=<url>`, an allowlisted proxy
(twimg, Substack, YouTube thumbnails, anthropic.com) with a 5 MB cap and a
month of caching, so they land as ordinary same-origin responses the worker can
hold, count and evict.

**Keep offline.** A PDF is eleven megabytes and a rendered voice a few, so
neither is cached because a page was opened. Documents with a file, and items
with saved audio, grow a quiet **Keep offline** in the reader's sheet; on,
the worker fetches and holds the whole file and the word becomes *Kept 10.5 MB*;
off, it evicts it. Because the whole file is held, the worker answers the Range
requests every `<audio>` element makes by slicing what it has.

### Measured

After one warm cycle over the real queue (252 unread, 30 warmed):

```
Offline copy: 4.7 MB, 31 items, updated 16:52.
  rl-shell   10 files      ~50 KB     chrome
  rl-pages   31 documents  ~4.6 MB    the list + 30 reader pages
  rl-media   14 pictures   ~250 KB    thumbnails and tweet photos
Browser quota 10.0 GB, 4.8 MB used.
```

Keeping the 154-page Anthropic report takes it to 15.4 MB. The `?` overlay
carries that line, live, from `caches` and `navigator.storage.estimate()`.

### Writing while offline

Reading offline is worth something on its own; marking things as you read them
is the other half. Every write the reader and the list make — status, star,
rating, tags, highlight, highlight-note, note, delete, progress — is held in
IndexedDB when it cannot be sent, applied to the page at once, and replayed in
order when the network comes back.

**When.** A write is queued when `navigator.onLine` is false *or* when the fetch
rejects rather than answering. The second test is the honest one: a laptop on a
captive portal and a phone whose radio came back before the tunnel did both say
they are online, and only a `TypeError` out of `fetch` means the browser could
not make the connection at all. A 400 or a 500 is an answer and is shown, not
queued.

**The record.** One object store, `writes`, in database `rl-queue` v1, keyed by
an autoincrementing id so the order of the queue is the order he did things:

```js
{ id: 7, v: 1, at: "2026-09-11T11:08:27.410Z",
  path: "/api/reading/status",                  // the same endpoint the page uses
  body: { file: "…md", star: true },            // the same payload
  what: "status",                               // which endpoint, for collapsing
  file: "…md",                                  // for the post-replay refresh
  tries: 0, error: "", stuck: false }
```

Both the store schema (`RL_DB_V`) and the record (`v`) are versioned. A change
to the shape bumps `RL_DB_V` and migrates in `onupgradeneeded`; the per-record
`v` is there because another tab may still be writing the old shape into the
store while the new page reads it.

**Optimistically.** The page answers itself with what the server would have
said, from a local copy of the three lists that a write can change — the tags,
the highlights and their notes, the notes — handed over in `window.RL` and kept
in step. A note added offline even gets the server's `YYYY-MM-DD HH:MM` stamp,
so it reads identically to one added at the desk. Two endpoints have no local
answer and still refuse: **Replace**, which re-fetches from the web, and
**Queue** on a link, which runs `add.sh`. Making audio refuses too — it is a job
on the Mac that costs money.

**Replay.** On `online` and on every page load with a non-empty queue, in id
order, one at a time, through the same endpoints. Progress is collapsed first:
only the furthest percent per file survives, so a whole offline read costs the
note one write instead of thirty. Then:

- **ok** → the record is deleted and the file is noted.
- **a network error** → the Mac is still not there. Stop; everything else stays
  queued for the next `online`.
- **a refusal** → the record keeps its reason and its `tries`. After three it is
  `stuck`: no longer retried, still there, and named in the line — *1 refused
  (rating must be 1 to 7). Discard.* Tapping the line is the only thing that
  throws it away. Nothing is ever dropped where he cannot see it.

Afterwards the worker is told to `refresh` the pages of every file that was
touched, plus the list: the cached copies still say what the notes said before
the replay, and the next visit should not be the old state.

**Conflicts.** There is no merge and none is needed. Every one of these
endpoints rewrites a single frontmatter key, or appends one line under
`## Highlights` / `## Notes`, and leaves the rest of the file byte for byte. Two
devices touching the same note usually touch different keys; where they touch
the same key, last writer wins — which for a star or a rating is the answer he
would expect anyway.

**Where he sees it.** *3 changes waiting.* in the line under the header, and
`3 waiting` in the reader's bar, left of the three dots. Both go away on their
own when the queue drains.

### Offline, what he sees

A muted line under the header, and only when there is something to say:

- *Offline, showing the copy from 16:52.* — the worker served the cache and the
  refresh behind it failed.
- *A newer copy is ready. Reload.* — it succeeded and the answer differs.
- *3 changes waiting.* — that many writes are held, and will be sent.
- *Offline. That change needs the Mac.* — one of the two writes that cannot be
  held (Replace, or saving a link) was asked for.

Reading is whole: body, highlights, notes, transcript, figures, kept files, the
theme switch, the chips, the search, the keyboard. The YouTube player is a black
rectangle, which is honest. Progress never fires a beacon into nothing — it goes
into the queue, and the replay collapses the lot to the furthest point.

### The chrome moved

All of it. `reading.ts` was ~100 KB of CSS and JS in template literals, sent
again with every page; it is now markup plus a few `<link>` and `<script src>`
lines:

```
dashboard/static/reading/
  reading.css list.css reader.css save.css      was BASE_CSS, LIST_CSS, READER_CSS, SAVE_CSS
  common.js                                     the theme switch, the ? overlay, the offline plumbing
  list.js reader.js wait.js                     the three page scripts
  sw.js                                         the worker
dashboard/pages/mac/reading-offline.ts          serves all of the above, plus the manifest and /reading/img
```

Served at `/reading/static/<file>?v=<content hash>` — inside the scope, so the
worker can precache it — with `max-age=31536000, immutable`. Only three things
are still inline, and each has to be: the Flexoki tokens and the forced-dark
override (they have to sit in the cascade before the sheets that use them), the
theme boot (it runs before first paint so a stored choice never flashes), and a
small `window.RL = {…}` with what the server knew — the file name, the kind, the
progress, the voices, the cues.

The dashboard's own `static/style.css` is served a second time at
`/reading/static/dashboard.css`, for the same scope reason: it carries the font
stack and the `.md` renderer the reading pages build on, and a copy at
`/static/` is a copy the worker can never reach. `layout()` grew an optional
`stylesheet` so there is one link, not two.

## The player at the top (2026-09-11)

Reading along with a video means the picture has to still be there. It is now:
once the player's place in the page has passed the top of the screen the picture
pins there, shrinks, and the transcript goes on scrolling under it. Scroll back
to the top and it is full width in the flow again. `Hide` slides it off the top
while it keeps playing; the same word brings it back, and reaching the top
forgets it. Both shapes do this — the scriptable player with cues, and the plain
embed a video with no transcript gets.

**Why the `position: sticky` that was already there did nothing.** `reading.css`
opened with `html, body { overflow-x: hidden }`, to stop a phone panning a page
one pixel too wide. `overflow-x: hidden` makes the other axis compute to `auto`,
which makes `<body>` a scroll container, and a scroll container is what a sticky
box resolves against — so the player was sticking faithfully to a box that never
scrolls. It is `overflow-x: clip` now, behind `@supports`, which cuts the same
overflow without making a scroller. Worth knowing for anything else on these
pages that wants to stick.

**Why it is not sticky even so.** A sticky box that shrinks as it pins hands its
height back to the flow, and everything under it jumps up by that much. So the
slot keeps its full 16:9 place in the page and never changes, and the picture
inside it is what goes `position: fixed`. The words under it do not move.

**The sizes** are in `:root` in `reader.css`, in `vh`, so a turn of the phone or
a URL bar sliding away re-answers them with no JS: `--rl-pin-h` is `min(26vh,
240px)` on a desk and `min(24vh, 150px)` on a phone, the width follows at 16:9
and is capped by the reading column, and the pinned player is left-aligned with
the column. A cue's `scroll-margin-top` is derived from the same number, so the
cue the player scrolls to lands under the picture rather than behind it.

**The setting.** If `window.RLSettings` is there, the player reads `pin-player`
through it (`.on("pin-player", fn)`); false means it never pins. Absent, it
pins, which is the default.

## The bottom of the screen (2026-09-11)

Listening to an article on a phone, the bottom of the reader was **six rows and
about 250 px of chrome** over the words: the scrubber, the transport, a line
saying `Thalia (Deepgram), 67 min, Sep 11` with the speed chips, `Close` alone
on the next line because that one had run out of width, `Done Star Open ···`,
and `Keep offline Obsidian Copy Replace… Delete`. It is **four rows and 194 px**
now, measured at 390 px: the player is 133 px (scrubber 24, transport 44, the
meta line 44) and the bar is 61 px (one 44 px row plus its padding).

**One row in the bar.** `Done`, `Star` and `Open` stay on the left — they are
what he presses — and the `···` on the right is the way to everything else. The
five minor words moved into the sheet it opens, and with them the `@media
(max-width: 460px)` rule that used to give them a row of their own.

**One sheet, two kinds of thing.** *This item, and settings*: `Keep offline`,
`Obsidian`, `Copy`, `Replace…`, `Delete` as 44 px lines, then a hairline, then
the two site-wide switches with *These apply to every item* still attached to
them and nothing else. Actions first, because he opens this to do something far
more often than to change something. Same ids as when they were words in the
bar, so every handler in `reader.js` was left alone — except the two that ask a
question: Delete and Replace… now call `settingsOpen(false)` before setting
`bar.dataset.confirm`, so the sheet gets out of the way and the confirm row or
the URL field appears in the bar, where it always did. `d then y` is untouched;
it drives the same `#rl-del-yes`.

**One line in the player.** The voice line lost the provider in brackets and the
date and became `Thalia · 10 min` (`· at 12:34` when there is a resume point),
which leaves room for the speed chips and `Close` on the same line — the row
that used to wrap. `.rl-audio-row` is `flex-wrap: nowrap` rather than merely
unlikely to wrap, and the name is the one thing that can give, with
`text-overflow: ellipsis`. The facts come off the saved row as `data-label` and
`data-secs` rather than by parsing its sentence back apart, and `savedRowHtml`
on the server and `paintSaved` in the client both write them, as they must. A
page out of the worker's cache can predate the attributes, so `shortLabel` falls
back to the row's own text. The speed chips and `Close` are 44 px tall now; they
are still only as wide as their words, which is how they were.

The chrome is hashed per file and the worker's shell cache is named after all of
their hashes together (`buildId()` in `reading-offline.ts`), so editing these
three files retires the old cache by itself. Testing on a device that already
has the worker still means two reloads.

## The header that follows him down (2026-09-11)

> "if you scroll back up, then i want to see a header somehow so that the page i
> am reading is clear, and clicking on it - we go right back up. and then it
> might also become a way to tag or click on listen from your listening position
> instead of having to go all the way up top"

One slim line at the top of the reader, `#rl-sticky`, built in `stickyHtml()` in
`pages/mac/reading.ts`, driven by the `// the header that follows him down`
block near the end of `static/reading/reader.js`, styled in `reader.css`.

**When it is there.** Never while the `h1` is still on the screen — the real
title is right there and louder. Below that it does what a phone reader does:
hidden while he scrolls down, revealed when he scrolls up. Reading forward is
minutes at a time and a bar across the top of it is a bar across a line of the
text; scrolling up is nearly always a question — *what is this, where was I* —
and the answer to that question is what the bar holds.

**The threshold is 24 px**, and a run restarts at the turn, so it costs the same
twenty-four pixels in either direction whichever way he was going before. That
is under one line of body text (18px at 1.6 is 29px), which makes the rule easy
to say: a nudge of less than a line changes nothing; move it by a line and the
header is there. A thumb resting on a phone is never quite still and a flick has
overshoot in it, so with no threshold at all it flickers. It is also always
revealed when the page has stopped at the very bottom: there is no text below to
cover, and the way back up is the thing he most likely wants next.

**What it holds.** The title on the left, one line, ellipsis, 14px `--text2` so
it reads as chrome and not as a heading. Tapping the title — or anywhere in the
row that is not a control — smooth-scrolls to the top. Two quiet controls on the
right, each only drawn when it can do something:

| kind | title | Listen | Tag |
|---|---|---|---|
| article | yes | yes | yes |
| document (with a text layer) | yes | yes | yes |
| X long-form post | yes | yes | yes |
| plain tweet | yes | — | yes |
| video | suppressed while the picture is at the top; otherwise title only | — | yes |

`Listen` is drawn from the same `canListen()` the panel is, so the two can never
disagree. `Tag` is drawn always, because every reader page has a tag row, and
the script still checks for `#rl-tag-add` before wiring it.

**Listen, from where he is.** It calls into the player rather than copying it,
in this order: `togglePlay()` first — if the player is up, that button is pause
and play; then the first `.rl-saved-row`, through `playRow()`, which already
starts at whichever of the note's `audio_at` and this browser's pointer is
further, which is the whole point of not having to go up to the panel; and only
with nothing rendered does it do what the `Listen` control at the top does
(`listenToggle()`) and scroll that control into view. The word on the button is
the next thing it will do — `Listen`, `Play`, `Pause` — painted from the same
`paintPlaying()` the transport uses, through an `onAudioState` hook.

**Tagging, from where he is.** Tapping `Tag` opens a second row inside the
header: the current tags as chips (tap to drop) and an input. Enter adds. Both
go through `addTag` / `removeTag` and so through `/api/reading/tags`, and
`renderTags()` repaints the controls block and the header together. The other
option — scroll down to the existing `#rl-tag-input` and focus it — is three
lines shorter and was rejected because it does the exact thing he asked to be
rid of: it takes him back to the top, and the header, which is absent at the
top, would vanish under his thumb on the way.

**Sharing the top of the screen.** One order, settled in `reader.css`:

```
8  .rl-prog-top   two pixels of accent, top: 0, never covered
7  .rl-resume     the six-second "Resume at N%" strip, top: 2
6  .rl-sticky     the header, top: 0
5  .rl-player     the pinned video
```

The header goes flush to the top and lets the progress hairline paint over its
first two pixels, which reads as its own top edge; leaving those two pixels
clear showed a sliver of moving body text above it at 1280. The two that would
then share the same y do not stack, they take turns: `sayResume()` sets
`body[data-resume="1"]` for its six seconds and that pushes the header off the
screen, because one voice at the top at a time.

**Video: the picture wins.** `body:has(.rl-player.rl-pin-top) .rl-sticky
{ display: none }`. A video held at the top is already a picture of what he is
watching and carries its own `Hide`; a title line above it would say the same
thing twice, and it would have to push the picture down and up as it revealed
and hid — exactly the jump the player's one fixed height exists to prevent. The
header comes back the moment the player scrolls off the top.

`rl-pin-top`, not `rl-pin`: the player is `position: sticky` in the stylesheet
whatever the "Hold the video" setting says, so with that setting off the picture
is still up there and the header still has to give way. `rl-pin` is the
shrink-and-Hide behaviour; `rl-pin-top` is the plain fact of being at the top,
and the pin block sets it from `pinned` alone.

**Small print.** 44px on every tap target. `prefers-reduced-motion` turns off
both the slide and the smooth scroll to the top. `visibility` rides the
transform so nothing off-screen is tabbable or read aloud. The title is
`user-select: none` because it is a button that happens to be made of the title;
nothing else about selection, the highlight pill, the link pill or the restored
reading position changes. No setting for it: it is absent at the top and out of
the way while he reads forward, so there is nothing to turn off.

**Cache.** There is no build constant to bump — `reading-offline.ts` hashes each
chrome file by content and `buildId()` hashes the set, so editing `reader.js` or
`reader.css` retires the worker's shell cache by itself. Expect the usual two
reloads when testing.
