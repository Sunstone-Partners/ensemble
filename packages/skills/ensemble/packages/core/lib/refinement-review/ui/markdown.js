/* Minimal CommonMark-ish renderer for the refinement-review UI.
   Exposes window.RRMarkdown = { render }.
   Each block element (heading, paragraph, list, code, blockquote)
   carries a `data-source-line` attribute so comments can anchor
   to the original line range. */
(function () {
  'use strict';

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function inline(s) {
    let t = escapeHtml(s);
    // Links: [text](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, a, u) => {
      return `<a href="${u}" rel="noopener">${a}</a>`;
    });
    // Inline code: `code` (no nested code inside the rendered output)
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    // Bold: **text**
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    t = t.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
    return t;
  }

  function fencedLang(line) {
    const m = /^```\s*(\S+)?\s*$/.exec(line);
    return m ? m[1] || '' : null;
  }

  function headingLevel(line) {
    const m = /^(#{1,6})\s+/.exec(line);
    return m ? m[1].length : 0;
  }

  function ruleLine(line) {
    return /^-{3,}$|^\*{3,}$|^_{3,}$/.test(line);
  }

  function isListItem(line) {
    return /^\s*[-*+]\s+/.test(line) || /^\s*\d+\.\s+/.test(line);
  }

  function listType(line) {
    if (/^\s*[-*+]\s+/.test(line)) return 'ul';
    if (/^\s*\d+\.\s+/.test(line)) return 'ol';
    return null;
  }

  function blockquoteLine(line) {
    return /^>\s?/.test(line);
  }

  function render(markdown) {
    const lines = String(markdown || '').split(/\r\n|\r|\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const lang = fencedLang(line);
      if (lang !== null) {
        const startLine = i + 1;
        i++;
        const body = [];
        while (i < lines.length && fencedLang(lines[i]) === null) {
          body.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // closing fence
        const code = body.join('\n');
        const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
        out.push(`<pre data-source-line="${startLine}"><code${langAttr}>${escapeHtml(code)}</code></pre>`);
        continue;
      }

      // Heading
      const lvl = headingLevel(line);
      if (lvl > 0) {
        const text = line.slice(lvl + 1);
        out.push(`<h${lvl} data-source-line="${i + 1}">${inline(text)}</h${lvl}>`);
        i++;
        continue;
      }

      // Thematic rule
      if (ruleLine(line)) {
        out.push(`<hr data-source-line="${i + 1}" />`);
        i++;
        continue;
      }

      // Blockquote (one or more `> ` lines). Inline content only —
      // never wrap in `<p>` so the outer `<blockquote>` is the sole
      // data-source-line-bearing block.
      if (blockquoteLine(line)) {
        const startLine = i + 1;
        const buf = [];
        while (i < lines.length && blockquoteLine(lines[i])) {
          buf.push(lines[i].replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote data-source-line="${startLine}">${inline(buf.join('\n'))}</blockquote>`);
        continue;
      }

      // Lists
      const lt = listType(line);
      if (lt) {
        const startLine = i + 1;
        const tag = lt;
        const items = [];
        let cur = null;
        while (i < lines.length) {
          const l = lines[i];
          if (listType(l) === lt) {
            if (cur) items.push(cur);
            cur = { line: i + 1, text: l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '') };
            i++;
          } else if (cur && /^\s{2,}\S/.test(l) && l.trim() !== '') {
            cur.text += '\n' + l.trim();
            i++;
          } else {
            break;
          }
        }
        if (cur) items.push(cur);
        const inner = items
          .map((it) => `<li data-source-line="${it.line}">${inline(it.text)}</li>`)
          .join('');
        out.push(`<${tag} data-source-line="${startLine}">${inner}</${tag}>`);
        continue;
      }

      // Blank line — skip
      if (!line.trim()) {
        i++;
        continue;
      }

      // Paragraph: collect until blank / block start
      const startLine = i + 1;
      const buf = [line];
      i++;
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        headingLevel(lines[i]) === 0 &&
        !ruleLine(lines[i]) &&
        !isListItem(lines[i]) &&
        !blockquoteLine(lines[i]) &&
        fencedLang(lines[i]) === null
      ) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<p data-source-line="${startLine}">${inline(buf.join('\n'))}</p>`);
    }

    return out.join('\n');
  }

  window.RRMarkdown = { render };
})();
