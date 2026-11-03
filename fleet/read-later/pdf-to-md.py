#!/usr/bin/env python3
"""pdf-to-md.py <file.pdf> [--title] [--plain] [--assets <dir>]

Turns a PDF into reading markdown for the read-later notes, the way the
Obsidian clipper turns a web page into one: headings that are headings,
paragraphs that are paragraphs, links that still go somewhere.

The structured pass reads `pdftohtml -xml`, which gives every printed line its
font size, weight and position. The most common size is the body; anything
markedly larger is a heading (two tiers), small grey lines are captions, bold
lines at body size are run-in headings. Lines are regrouped into paragraphs by
the vertical gap between them, bullets start their own, a word broken at the
margin is mended, a sentence that runs over a page break is joined back. The
running header and page numbers that repeat on most pages are dropped, and a
quiet page mark is left where each page begins so a passage can be found in the
original.

With --assets, pdftohtml also writes the page images, and the ones that look
like figures go back into the text at the height they sat on the page. Most of
what a PDF embeds is not a figure — a wordmark in the header, a watermark, the
cover art — so an image has to be big enough, unrepeated, and smaller than the
page to survive. The caption under a figure becomes its alt text.

If pdftohtml is missing or the XML will not parse, the plain pass on pdftotext
does the reflow without the typography.

  --title   print the best title instead of the body (metadata, else the
            first real line of page one, else nothing)
  --plain   force the pdftotext pass
  --assets  write the page images into this directory, keep the figures, and
            leave nothing else behind in it. Without it no image is written.
"""
import hashlib
import html
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from urllib.parse import quote

PAGE_MARK = '<span class="rl-pg" id="rl-page-{n}">Page {n}</span>'
# pdftohtml writes a link to another page of the same file as "<name>.html#<page>"
INTERNAL_LINK = re.compile(r"^[^/#]*\.html#(\d+)$")

# pdftohtml names the images it writes after its own output file
IMG_BASE = "doc"
WEB_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
# What separates a figure from the page's own furniture. A wordmark or a rule is
# thin, a watermark comes back page after page, cover art covers the page. The
# area clause is the let-off for the wide, short banner that is a real figure.
MIN_SIDE = 120.0
MIN_AREA = 0.025
BG_AREA = 0.85
REPEAT_PAGES = 3
# A caption sits right under its figure, and announces itself
CAPTION_GAP = 80.0
CAPTION = re.compile(r"^\*?\s*(?:figure|fig\.|table|chart|exhibit|diagram)\s*\d", re.I)

BULLET = re.compile(r"^[•·▪◦●–—\-\*]\s+")
PAGE_NO = re.compile(r"^(?:page\s+)?\d{1,4}(?:\s*(?:of|/)\s*\d{1,4})?$", re.I)
ROMAN = re.compile(r"^[ivxlcdm]{1,7}$", re.I)
SENTENCE_END = re.compile(r"[.!?:;\"”’)\]]\s*$")


def run(cmd: list[str], timeout: int = 120) -> str:
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


# ── title ────────────────────────────────────────────────────────────────────

def pdfinfo_title(path: str) -> str:
    out = run(["pdfinfo", path], 30)
    m = re.search(r"^Title:\s*(.+)$", out, re.M)
    if not m:
        return ""
    t = m.group(1).strip()
    # Word and Google Docs leave their own name in the slot
    t = re.sub(r"^(Microsoft Word|Google Docs)\s*[-:–]\s*", "", t)
    t = re.sub(r"\.(docx?|pdf|pptx?|tex)$", "", t, flags=re.I)
    if not t or t.lower() in {"untitled", "untitled document", "document", "title"}:
        return ""
    return t


def best_title(path: str) -> str:
    t = pdfinfo_title(path)
    if t:
        return t
    first = run(["pdftotext", "-enc", "UTF-8", "-f", "1", "-l", "1", path, "-"])
    for line in first.split("\n"):
        s = re.sub(r"\s+", " ", line).strip()
        if len(s) >= 8 and len(s.split()) >= 2 and not PAGE_NO.match(s):
            return s[:160]
    return ""


# ── shared helpers ───────────────────────────────────────────────────────────

def norm(line: str) -> str:
    # digits fold to "#", and trailing numbers go: the running footer carries
    # the page number on the same baseline everywhere except the cover
    key = re.sub(r"\d+", "#", re.sub(r"\s+", " ", line.strip()).lower())
    return re.sub(r"( #)+$", "", key)


def repeated_lines(pages: list[list[str]]) -> set[str]:
    """Lines that recur on most pages are a header or a footer, not the text."""
    n = len(pages)
    if n < 3:
        return set()
    seen: dict[str, int] = {}
    for lines in pages:
        for key in {norm(l) for l in lines if l.strip()}:
            if len(key) <= 120:
                seen[key] = seen.get(key, 0) + 1
    floor = max(3, int(n * 0.3))
    return {k for k, c in seen.items() if c >= floor}


def is_noise(line: str, drop: set[str]) -> bool:
    s = line.strip()
    if not s:
        return False
    if PAGE_NO.match(s) or ROMAN.match(s):
        return True
    return norm(s) in drop


def escape_text(text: str) -> str:
    # marked passes raw HTML through, and a "#" at the start of a line is a
    # heading; neither is something a PDF meant
    text = html.escape(text, quote=False)
    return re.sub(r"^([#>])", r"\\\1", text)


def continues(prev: str, nxt: str) -> bool:
    """A sentence that ran over the page break: no end punctuation, then a
    lowercase start on the other side."""
    if not prev or not nxt:
        return False
    if nxt.startswith(("- ", "#", "*")) or prev.startswith(("#", "- ", "*")):
        return False
    return not SENTENCE_END.search(prev) and nxt[:1].islower()


def emit(blocks: list[tuple[int, str]]) -> str:
    out: list[str] = []
    page = 1
    for pg, p in blocks:
        if pg != page:
            page = pg
            out.append(PAGE_MARK.format(n=pg))
        out.append(p)
    return "\n\n".join(out).strip() + "\n"


# ── structured pass: pdftohtml -xml ───────────────────────────────────────────

class Line:
    __slots__ = ("top", "bottom", "left", "right", "size", "bold", "italic", "text", "md")

    def __init__(self, top, bottom, left, right, size, bold, italic, text, md):
        self.top, self.bottom, self.left, self.right = top, bottom, left, right
        self.size, self.bold, self.italic, self.text, self.md = size, bold, italic, text, md


class Image:
    __slots__ = ("top", "bottom", "width", "height", "name", "digest")

    def __init__(self, top, height, width, name):
        self.top, self.bottom, self.width, self.height = top, top + height, width, height
        self.name, self.digest = name, ""


class Page:
    __slots__ = ("no", "width", "height", "lines", "images")

    def __init__(self, no, width, height, lines, images):
        self.no, self.width, self.height = no, width, height
        self.lines, self.images = lines, images


def pdftohtml_xml(path: str, assets: str) -> str:
    """The XML, and with an assets directory the page images beside it.

    Without the directory the run keeps `-i`, which makes pdftohtml ignore
    images entirely. With it the images have to land somewhere, and pdftohtml
    puts them next to its output file and names them after it — so the output
    file goes in the assets directory, and is read back and removed."""
    if not assets:
        return run(["pdftohtml", "-xml", "-i", "-hidden", "-enc", "UTF-8", "-stdout", path], 180)
    os.makedirs(assets, exist_ok=True)
    # pdftohtml refuses to overwrite, and an earlier run's images are not ours
    # to show a second time
    clear_assets(assets)
    out = os.path.join(assets, IMG_BASE + ".xml")
    run(["pdftohtml", "-xml", "-hidden", "-enc", "UTF-8", path, out], 600)
    try:
        with open(out, encoding="utf-8", errors="replace") as fh:
            xml = fh.read()
    except OSError:
        return ""
    unlink(out)
    return xml


def clear_assets(assets: str) -> None:
    """Everything this script has ever written into the directory, gone."""
    try:
        names = os.listdir(assets)
    except OSError:
        return
    for name in names:
        if name == IMG_BASE + ".xml" or name.startswith(IMG_BASE + "-"):
            unlink(os.path.join(assets, name))


def unlink(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def digest(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            return hashlib.sha1(fh.read()).hexdigest()
    except OSError:
        return ""


def to_web(assets: str, name: str) -> str:
    """pdftohtml writes PNG and JPEG, which a browser already understands. If a
    build of it ever writes something else, it is converted or it is dropped."""
    stem, ext = os.path.splitext(name)
    if ext.lower() in WEB_EXT:
        return name
    src, dest = os.path.join(assets, name), os.path.join(assets, stem + ".png")
    for cmd in (["sips", "-s", "format", "png", src, "--out", dest],
                ["magick", src, dest], ["convert", src, dest]):
        run(cmd, 60)
        if os.path.exists(dest) and os.path.getsize(dest):
            unlink(src)
            return stem + ".png"
    return ""


def keep_figures(pages: list[Page], assets: str) -> None:
    """Sorts the page images into figures and furniture, and deletes the
    furniture: what the directory holds afterwards is what the note shows.

    The same bytes on several pages is a letterhead or a watermark. A thin one
    is a rule or a wordmark, unless it still fills a good part of the column,
    which is what a wide banner figure does. One that covers the page is the
    page's own background, not something printed on it."""
    seen: dict[str, set[int]] = {}
    for pg in pages:
        for im in pg.images:
            im.digest = digest(os.path.join(assets, im.name))
            seen.setdefault(im.digest, set()).add(pg.no)
    for pg in pages:
        area = pg.width * pg.height
        keep: list[Image] = []
        for im in pg.images:
            share = (im.width * im.height) / area if area else 0.0
            if not im.digest:
                continue
            if len(seen[im.digest]) >= REPEAT_PAGES:
                continue
            if min(im.width, im.height) < MIN_SIDE and share < MIN_AREA:
                continue
            if share > BG_AREA:
                continue
            name = to_web(assets, im.name)
            if not name:
                continue
            im.name = name
            keep.append(im)
        pg.images = keep
    shown = {im.name for pg in pages for im in pg.images}
    for name in os.listdir(assets):
        if name not in shown:
            unlink(os.path.join(assets, name))


def asset_url(stem: str, name: str) -> str:
    return "/reading/asset?f=" + quote(stem + "/" + name, safe="/")


def alt_text(caption: str) -> str:
    """A caption reads as alt text once the markdown is taken back out of it."""
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", caption)
    s = html.unescape(s.replace("*", "").replace("\\", "")).replace("[", "").replace("]", "")
    return re.sub(r"\s+", " ", s).strip()[:200]


def insert_figures(blocks: list[tuple[float, str, str]], pg: Page, stem: str) -> None:
    """Each figure goes back where it sat: above the first block of text that
    began below it. A caption directly underneath names the figure, so it
    becomes the alt text — and stays where it is, because it reads as a caption
    in the note too."""
    for im in sorted(pg.images, key=lambda i: i.top, reverse=True):
        at = next((k for k, b in enumerate(blocks) if b[0] > im.top), len(blocks))
        alt = ""
        if at < len(blocks):
            top, tier, text = blocks[at]
            if top - im.bottom <= CAPTION_GAP and (tier == "small" or CAPTION.match(text)):
                alt = alt_text(text)
        # an uncaptioned figure still says where it came from, for a reader who
        # cannot see it
        alt = alt or "Figure on page %d" % pg.no
        blocks.insert(at, (im.top, "img", "![%s](%s)" % (alt, asset_url(stem, im.name))))


def inline_md(el: ET.Element) -> tuple[str, str, bool, bool]:
    """One <text> element to (plain, markdown, all_bold, all_italic)."""
    plain_parts: list[str] = []
    md_parts: list[str] = []
    bold_chars = italic_chars = total = 0

    def walk(node: ET.Element, b: bool, i: bool, href: str | None):
        nonlocal bold_chars, italic_chars, total
        tag = node.tag.lower()
        if tag == "b":
            b = True
        elif tag == "i":
            i = True
        elif tag == "a":
            href = node.get("href") or href
        if node.text:
            t = node.text
            plain_parts.append(t)
            md_parts.append((t, b, i, href))
            n = len(t.strip())
            total += n
            if b:
                bold_chars += n
            if i:
                italic_chars += n
        for child in node:
            walk(child, b, i, href)
            if child.tail:
                t = child.tail
                plain_parts.append(t)
                md_parts.append((t, b, i, href))
                n = len(t.strip())
                total += n
                if b:
                    bold_chars += n
                if i:
                    italic_chars += n

    walk(el, False, False, None)
    plain = "".join(plain_parts)

    # markdown: escape text, wrap links; bold and italic are decided per line,
    # not per fragment, because a whole bold line is a heading and a bold word
    # inside a sentence is rarely worth the asterisks in a reflowed text
    md = ""
    for t, b, i, href in md_parts:
        s = escape_text(t)
        if href and s.strip():
            m = INTERNAL_LINK.match(href)
            target = f"#rl-page-{m.group(1)}" if m else href
            s = f"[{s.strip()}]({target}){' ' if s.endswith(' ') else ''}"
        md += s
    all_bold = total > 0 and bold_chars >= total * 0.9
    all_italic = total > 0 and italic_chars >= total * 0.9
    return plain, md, all_bold, all_italic


def parse_xml(path: str, assets: str = "") -> list[Page] | None:
    xml = pdftohtml_xml(path, assets)
    if not xml.strip():
        return None
    # pdftohtml can emit control characters that the parser refuses
    xml = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", xml)
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return None

    fonts: dict[str, tuple[float, str]] = {}
    pages: list[Page] = []
    for page in root.iter("page"):
        try:
            pno = int(page.get("number", "0"))
            pw, ph = float(page.get("width", "0")), float(page.get("height", "0"))
        except ValueError:
            continue
        images: list[Image] = []
        for im in page.iter("image"):
            name = os.path.basename(im.get("src", "") or "")
            try:
                top, h = float(im.get("top", "0")), float(im.get("height", "0"))
                w = float(im.get("width", "0"))
            except ValueError:
                continue
            if name:
                images.append(Image(top, h, w, name))
        for fs in page.iter("fontspec"):
            try:
                fonts[fs.get("id", "")] = (float(fs.get("size", "0")), fs.get("color", "") or "")
            except ValueError:
                pass
        frags = []
        for t in page.iter("text"):
            plain, md, b, i = inline_md(t)
            if not plain.strip():
                continue
            try:
                top = float(t.get("top", "0")); left = float(t.get("left", "0"))
                w = float(t.get("width", "0")); h = float(t.get("height", "0"))
            except ValueError:
                continue
            size, _ = fonts.get(t.get("font", ""), (h, ""))
            frags.append((top, left, w, h, size, b, i, plain, md))
        frags.sort(key=lambda f: (round(f[0]), f[1]))

        # fragments on one baseline are one line
        lines: list[Line] = []
        for top, left, w, h, size, b, i, plain, md in frags:
            if lines and abs(lines[-1].top - top) <= max(3.0, h * 0.4):
                ln = lines[-1]
                gap = left - ln.right
                sep = " " if gap > 2 and not ln.text.endswith(" ") and not plain.startswith(" ") else ""
                ln.text += sep + plain
                ln.md += sep + md
                ln.right = max(ln.right, left + w)
                ln.bottom = max(ln.bottom, top + h)
                ln.size = max(ln.size, size)
                ln.bold = ln.bold and b
                ln.italic = ln.italic and i
            else:
                lines.append(Line(top, top + h, left, left + w, size, b, i, plain, md))
        for ln in lines:
            ln.text = re.sub(r"\s+", " ", ln.text).strip()
            ln.md = re.sub(r"\s+", " ", ln.md).strip()
        pages.append(Page(pno, pw, ph, [l for l in lines if l.text], images))
    return pages or None


def structured_markdown(path: str, assets: str = "") -> str | None:
    pages = parse_xml(path, assets)
    if not pages:
        return None

    # the body size is where most of the characters are
    weight: Counter = Counter()
    for pg in pages:
        for ln in pg.lines:
            weight[round(ln.size)] += len(ln.text)
    if not weight:
        return None
    body = weight.most_common(1)[0][0] or 1

    drop = repeated_lines([[l.text for l in pg.lines] for pg in pages])
    stem = ""
    if assets:
        keep_figures(pages, assets)
        stem = os.path.basename(os.path.normpath(assets))

    def tier(ln: Line) -> str:
        r = ln.size / body
        if r >= 1.7:
            return "h2"
        if r >= 1.28:
            return "h3"
        if r >= 1.05 and ln.bold:
            return "h4"
        if r <= 0.85:
            return "small"
        if ln.bold and len(ln.text) <= 90 and not SENTENCE_END.search(ln.text):
            return "h4"
        return "p"

    blocks: list[tuple[int, str]] = []
    for pg in pages:
        here: list[tuple[float, str, str]] = []  # top, tier, markdown
        cur: list[Line] = []
        cur_tier = "p"

        def flush():
            nonlocal cur
            if not cur:
                return
            parts: list[str] = []
            for ln in cur:
                if parts and parts[-1].endswith("-") and ln.md[:1].islower() and not parts[-1].endswith(" -"):
                    parts[-1] = parts[-1][:-1] + ln.md
                else:
                    parts.append(ln.md)
            text = " ".join(parts).strip()
            if len(text) <= 1:
                cur = []
                return
            if cur_tier == "h2":
                text = "## " + text.replace("**", "")
            elif cur_tier == "h3":
                text = "### " + text.replace("**", "")
            elif cur_tier == "h4":
                text = "**" + text + "**"
            elif cur_tier == "small":
                text = "*" + text + "*"
            elif BULLET.match(text):
                text = "- " + BULLET.sub("", text)
            here.append((cur[0].top, cur_tier, text))
            cur = []

        prev: Line | None = None
        for ln in pg.lines:
            if is_noise(ln.text, drop):
                continue
            t = tier(ln)
            new_block = False
            if prev is None:
                new_block = True
            else:
                gap = ln.top - prev.bottom
                line_h = max(prev.bottom - prev.top, 1.0)
                if t != cur_tier:
                    new_block = True
                elif gap > line_h * 0.9:
                    new_block = True
                elif BULLET.match(ln.text):
                    new_block = True
                elif t in ("h2", "h3") and gap > line_h * 0.3:
                    new_block = True
            if new_block:
                flush()
                cur_tier = t
            cur.append(ln)
            prev = ln
        flush()
        insert_figures(here, pg, stem)
        blocks.extend((pg.no, text) for _, _, text in here)

    # the cover repeats the title the note already carries as its heading
    title_key = norm(re.sub(r"[*#\[\]]", "", pdfinfo_title(path)))
    if title_key and blocks and blocks[0][0] == 1:
        first = norm(re.sub(r"[*#\[\]]", "", blocks[0][1]))
        if first == title_key:
            blocks.pop(0)

    # a sentence that ran over the page break
    merged: list[tuple[int, str]] = []
    for pno, text in blocks:
        if merged and merged[-1][0] != pno and continues(merged[-1][1], text):
            merged[-1] = (merged[-1][0], merged[-1][1] + " " + text)
        else:
            merged.append((pno, text))
    return emit(merged)


# ── plain pass: pdftotext ─────────────────────────────────────────────────────

def looks_like_heading(line: str, nxt: str) -> bool:
    if not nxt or len(line) > 60 or len(line.split()) > 6:
        return False
    if not line[:1].isupper() or SENTENCE_END.search(line) or line.endswith(","):
        return False
    if BULLET.match(nxt) or line.startswith("- "):
        return False
    return len(nxt) > 60 and nxt[:1].isupper()


def plain_paragraphs(lines: list[str], drop: set[str]) -> list[str]:
    out: list[str] = []
    cur: list[str] = []

    def flush():
        if cur:
            out.append(" ".join(cur))
            cur.clear()

    for idx, raw in enumerate(lines):
        s = re.sub(r"[ \t]+", " ", raw).strip()
        nxt = re.sub(r"[ \t]+", " ", lines[idx + 1]).strip() if idx + 1 < len(lines) else ""
        if not s:
            flush()
            continue
        if is_noise(s, drop):
            continue
        if BULLET.match(s):
            flush()
            cur.append("- " + BULLET.sub("", s))
            continue
        if cur:
            prev = cur[-1]
            if prev.endswith("-") and s[:1].islower() and not prev.endswith(" -"):
                cur[-1] = prev[:-1] + s
                continue
        elif looks_like_heading(s, nxt):
            out.append("**" + s + "**")
            continue
        cur.append(s)
    flush()
    return [p for p in out if len(p.strip()) > 1]


def plain_markdown(path: str) -> str:
    text = run(["pdftotext", "-enc", "UTF-8", path, "-"])
    if not text.strip():
        return ""
    pages = [p.split("\n") for p in text.split("\f")]
    if pages and not any(l.strip() for l in pages[-1]):
        pages.pop()
    drop = repeated_lines(pages)
    blocks: list[tuple[int, str]] = []
    for i, lines in enumerate(pages, start=1):
        for p in plain_paragraphs(lines, drop):
            p = escape_text(p) if not p.startswith("**") else p
            if blocks and blocks[-1][0] != i and continues(blocks[-1][1], p):
                blocks[-1] = (blocks[-1][0], blocks[-1][1] + " " + p)
            else:
                blocks.append((i, p))
    return emit(blocks)


def to_markdown(path: str, plain: bool = False, assets: str = "") -> str:
    if not plain:
        out = structured_markdown(path, assets)
        if out and len(out.strip()) > 40:
            return out
    # the plain pass shows no figures, so the ones already written are not ours
    if assets:
        clear_assets(assets)
    return plain_markdown(path)


def main() -> int:
    argv = sys.argv[1:]
    args: list[str] = []
    assets = ""
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--assets" and i + 1 < len(argv):
            assets, i = argv[i + 1], i + 2
            continue
        if a.startswith("--assets="):
            assets = a.split("=", 1)[1]
        elif not a.startswith("--"):
            args.append(a)
        i += 1
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    path = args[0]
    if "--title" in argv:
        sys.stdout.write(best_title(path))
        return 0
    sys.stdout.write(to_markdown(path, plain="--plain" in argv, assets=assets))
    return 0


if __name__ == "__main__":
    sys.exit(main())
