/** Markdown becomes terminal rows before viewport indexing; source text remains in the transcript. */
import { Marked, type Token, type Tokens } from 'marked';
import { renderMermaidASCII, renderMermaidSVG } from 'beautiful-mermaid';
import stringWidth from 'string-width';
import wrapAnsi from 'wrap-ansi';
import { stripVTControlCharacters } from 'node:util';
import { decodeHTML } from 'entities';
import { safeText } from '../transport/wire.ts';
import { renderMath } from './math.ts';

/** Local styles only; remote control sequences never become terminal instructions. */
export interface MarkdownSpan { text: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; inverse?: boolean }
/** A measured row retains plain text for searching, copying and row geometry. */
export interface MarkdownRow { text: string; spans?: MarkdownSpan[] }
interface MathToken { type: 'math'; raw: string; text: string; display: boolean }

const parser = new Marked({ gfm: true });
// Math is tokenized before Markdown escapes, but after fenced and inline code have claimed their source.
function mathToken(source: string, block: boolean): MathToken | undefined {
  const match = block
    ? /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:[ \t]*\n|$)/.exec(source)
    : /^(?:\$\$([^\n]+?)\$\$|\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<!\s)\$(?!\d)|\\\(([^\n]+?)\\\)|\\\[([^\n]+?)\\\])/.exec(source);
  if (!match) return undefined;
  return { type: 'math', raw: match[0], text: match.slice(1).find(value => value !== undefined)!,
    display: block || source.startsWith('$$') || source.startsWith('\\[') };
}
for (const level of ['block', 'inline'] as const) parser.use({ extensions: [{
  name: 'math', level,
  start: source => { const index = source.search(level === 'block' ? /\$\$|\\\[/ : /\$|\\[([]/); return index < 0 ? undefined : index; },
  tokenizer: source => mathToken(source, level === 'block'),
  renderer: token => mathHtml(token as MathToken),
}] });

const rendered = new Map<string, string>();
let cachedChars = 0;
function cached(key: string, render: () => string): string {
  const existing = rendered.get(key);
  if (existing !== undefined) return existing;
  const result = render();
  const size = key.length + result.length;
  if (size <= 64 * 1024) {
    while (rendered.size >= 128 || cachedChars + size > 256 * 1024) {
      const oldest = rendered.keys().next().value!;
      cachedChars -= oldest.length + rendered.get(oldest)!.length; rendered.delete(oldest);
    }
    rendered.set(key, result); cachedChars += size;
  }
  return result;
}

function mathText(token: MathToken): string {
  return cached(`math:${token.display}:${token.text}`, () => renderMath(token.text, token.display)?.text ?? token.raw.trimEnd());
}
function mathHtml(token: MathToken): string {
  return renderMath(token.text, token.display)?.html ?? `<code>${escapeHtml(token.raw)}</code>`;
}
function style(text: string, open: number, close: number): string {
  return `\x1b[${open}m${text.replaceAll(`\x1b[${close}m`, `\x1b[${close}m\x1b[${open}m`)}\x1b[${close}m`;
}
function plain(text: string): string { return safeText(text).replace(/\t/g, '    '); }

function inline(tokens: Token[]): string {
  return tokens.map(token => {
    switch (token.type) {
      case 'strong': return style(inline(token.tokens!), 1, 22);
      case 'em': return style(inline(token.tokens!), 3, 23);
      case 'del': return style(inline(token.tokens!), 9, 29);
      case 'codespan': return style(plain(token.text), 7, 27);
      case 'link': {
        const label = inline(token.tokens!); const href = plain(token.href);
        return style(label, 4, 24) + (stripVTControlCharacters(label) === href ? '' : ` (${href})`);
      }
      case 'image': return `${inline(token.tokens!)} (${plain(token.href)})`;
      case 'br': return '\n';
      case 'math': return mathText(token as MathToken);
      case 'html': return /^<br\s*\/?\s*>$/i.test(token.raw) ? '\n' : plain(token.raw);
      case 'escape': return plain(token.text);
      default: return 'tokens' in token && token.tokens ? inline(token.tokens)
        : plain(decodeHTML('text' in token && typeof token.text === 'string' ? token.text : token.raw));
    }
  }).join('');
}

function wrap(text: string, width: number, trim = true): string[] {
  return wrapAnsi(text, Math.max(1, width), { hard: true, trim }).split('\n');
}

function table(token: Tokens.Table, width: number): string[] {
  const cells = [token.header, ...token.rows].map(row => row.map(cell => inline(cell.tokens)));
  const count = token.header.length;
  const available = width - 3 * count - 1;
  // Narrow screens show each record vertically instead of squeezing columns into unreadable fragments.
  if (available < 12 * count) {
    if (cells.length === 1) return cells[0]!.flatMap(cell => wrap(style(cell, 1, 22), width));
    return cells.slice(1).flatMap((row, index) => [
      ...(index ? ['─'.repeat(Math.min(width, 20))] : []),
      ...row.flatMap((cell, column) => wrap(`${cells[0]![column] ? style(cells[0]![column]!, 1, 22) + ': ' : ''}${cell}`, width)),
    ]);
  }
  const widths = Array.from({ length: count }, (_, column) => Math.max(3, ...cells.map(row =>
    Math.max(...row[column]!.split('\n').map(line => stringWidth(line))))));
  while (widths.reduce((sum, value) => sum + value, 0) > available) {
    const column = widths.indexOf(Math.max(...widths)); widths[column]!--;
  }
  const border = (left: string, middle: string, right: string) => left + widths.map(size => '─'.repeat(size + 2)).join(middle) + right;
  const output = [border('┌', '┬', '┐')];
  cells.forEach((row, index) => {
    const lines = row.map((cell, column) => wrap(index === 0 ? style(cell, 1, 22) : cell, widths[column]!));
    for (let line = 0; line < Math.max(...lines.map(cell => cell.length)); line++) {
      output.push('│ ' + lines.map((cell, column) => {
        const value = cell[line] ?? ''; const padding = widths[column]! - stringWidth(value);
        const align = token.align[column]; const before = align === 'right' ? padding : align === 'center' ? Math.floor(padding / 2) : 0;
        return ' '.repeat(Math.max(0, before)) + value + ' '.repeat(Math.max(0, padding - before));
      }).join(' │ ') + ' │');
    }
    if (index === 0) output.push(border('├', '┼', '┤'));
  });
  output.push(border('└', '┴', '┘')); return output;
}

function diagram(source: string, width: number): string[] | undefined {
  if (source.length > 16 * 1024) return undefined;
  try {
    const text = cached(`mermaid:${source}`, () => {
      // The ASCII renderer measures code units. Reserve one extra cell for each wide BMP character.
      const padding = Array.from({ length: 256 }, (_, i) => String.fromCharCode(0xe000 + i)).find(c => !source.includes(c))!;
      if (!padding) throw new Error('No available diagram padding character');
      const measured = [...source].map(c => c + padding.repeat(Math.max(0, stringWidth(c) - c.length))).join('');
      return plain(renderMermaidASCII(measured, { colorMode: 'none' }).replaceAll(padding, ''));
    });
    const lines = text.trimEnd().split('\n').map(line => line.trimEnd());
    return lines.every(line => stringWidth(line) <= width) ? lines : undefined;
  } catch { return undefined; /* Unsupported or unfinished diagrams retain their source. */ }
}

function blocks(tokens: Token[], width: number): string[] {
  return tokens.flatMap(token => {
    switch (token.type) {
      case 'space': return [''];
      case 'def': return [];
      case 'heading': return wrap(style(inline(token.tokens!), 1, 22), width);
      case 'paragraph': case 'text': return wrap(token.tokens ? inline(token.tokens) : plain(token.text), width);
      case 'hr': return ['─'.repeat(width)];
      case 'table': return table(token as Tokens.Table, width);
      case 'blockquote': return blocks(token.tokens!, Math.max(1, width - 2)).map(line => width > 2 ? `│ ${line}` : line);
      case 'list': return (token as Tokens.List).items.flatMap((item, index) => {
        const marker = item.task ? item.checked ? '[x] ' : '[ ] ' : token.ordered ? `${Number(token.start) + index}. ` : '• ';
        const prefix = width > marker.length + 1 ? marker : '';
        return blocks(item.tokens.filter(child => child.type !== 'checkbox'), Math.max(1, width - prefix.length))
          .map((line, row) => `${row === 0 ? prefix : ' '.repeat(prefix.length)}${line}`);
      });
      case 'code': {
        const language = plain(token.lang ?? '').split(/\s/)[0]!;
        // An open fence is source, even when its current contents form a parseable partial diagram.
        const closed = /(?:^|\n) {0,3}(`{3,}|~{3,})[ \t]*(?:\n)?$/.test(token.raw);
        const graph = language === 'mermaid' && closed ? diagram(token.text, width) : undefined;
        if (graph) return graph;
        if (['math', 'latex', 'tex', 'mathjax'].includes(language) && closed) {
          return wrap(mathText({ type: 'math', text: token.text, raw: token.text, display: true }), width, false);
        }
        return [...wrap(`┌ ${language || 'code'}`, width, false), ...wrap(plain(token.text), width, false), '└'];
      }
      case 'math': return wrap(mathText(token as MathToken), width, false);
      default: return wrap(plain(token.raw), width);
    }
  });
}

// Decode only locally generated style codes after wrap-ansi has balanced styles across line breaks.
function row(text: string): MarkdownRow {
  const spans: MarkdownSpan[] = []; let current: Omit<MarkdownSpan, 'text'> = {}; let start = 0;
  const properties = { 1: 'bold', 3: 'italic', 4: 'underline', 7: 'inverse', 9: 'strikethrough',
    22: 'bold', 23: 'italic', 24: 'underline', 27: 'inverse', 29: 'strikethrough' } as const;
  for (const match of text.matchAll(/\x1b\[(\d+)m/g)) {
    if (match.index > start) spans.push({ text: text.slice(start, match.index), ...current });
    const code = Number(match[1]);
    if (code === 0) current = {};
    else if (code in properties) current[properties[code as keyof typeof properties]] = code < 20;
    start = match.index + match[0].length;
  }
  if (start < text.length) spans.push({ text: text.slice(start), ...current });
  return { text: spans.map(span => span.text).join(''), ...(text.includes('\x1b') ? { spans } : {}) };
}

/** Whether a source can contain Markdown constructs; false preserves incremental plain-text wrapping.
 * @param source - Complete text or a delta with its preceding line.
 * @returns Whether Markdown lexing is required.
 */
export function hasMarkdown(source: string): boolean {
  return /[*_`~\[\]<>|$\\#&\t]|(?:^|\n)(?: {4}| {0,3}(?:[-+=]{1,}|\d+[.)])(?:\s|$))|\n\s*\n/.test(source);
}

/** Parse GFM and TeX into styled rows whose widths match the terminal viewport.
 * @param source - Model or user message; remote terminal controls are removed.
 * @param width - Available terminal columns.
 * @returns Terminal rows, with literal source for invalid or unsupported rich blocks.
 */
export function markdownRows(source: string, width: number): MarkdownRow[] {
  width = Math.max(1, width);
  if (!hasMarkdown(source)) return wrap(plain(source), width).map(row);
  return blocks(parser.lexer(plain(source)), width).map(row);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeLink(href: string): string | undefined {
  return /^(?:https?:|mailto:)/i.test(href) && !/[\u0000-\u0020]/.test(href) ? escapeHtml(href) : undefined;
}
parser.use({ renderer: {
  html: token => escapeHtml(token.text),
  link(token) {
    const label = this.parser.parseInline(token.tokens); const href = safeLink(token.href);
    return href ? `<a href="${href}" rel="noreferrer">${label}</a>` : `${label} (${escapeHtml(token.href)})`;
  },
  image: token => `${escapeHtml(token.text)} (${escapeHtml(token.href)})`,
  code(token) {
    const language = (token.lang ?? '').split(/\s/)[0];
    if (language === 'mermaid' && token.text.length <= 16 * 1024) {
      try {
        const svg = renderMermaidSVG(token.text);
        // SVG image documents cannot run script or load external resources in the exported page.
        return `<img alt="Mermaid diagram" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
      } catch { /* Unsupported Mermaid syntax remains readable in a code block. */ }
    }
    if (['math', 'latex', 'tex', 'mathjax'].includes(language ?? '')) return mathHtml({ type: 'math', text: token.text, raw: token.text, display: true });
    return `<pre><code>${escapeHtml(token.text)}</code></pre>`;
  },
} });

/** Render safe, offline HTML with Mermaid SVG images and MathJax-generated MathML.
 * @param source - Markdown source, never trusted as executable HTML.
 * @returns An HTML fragment that requires no scripts or remote assets.
 */
export function markdownHtml(source: string): string { return parser.parse(safeText(source), { async: false }); }
