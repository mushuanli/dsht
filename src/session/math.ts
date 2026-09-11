/** MathJax compiles TeX locally; terminal output keeps explicit grouping when Unicode cannot express it. */
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import { STATE } from '@mathjax/src/js/core/MathItem.js';
import { TextNode, type MmlNode } from '@mathjax/src/js/core/MmlTree/MmlNode.js';
import { SerializedMmlVisitor } from '@mathjax/src/js/core/MmlTree/SerializedMmlVisitor.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import { safeText } from '../transport/wire.ts';

RegisterHTMLHandler(liteAdaptor());
const superscripts = Object.fromEntries([...('0123456789+-=()ni')].map((c, i) => [c, [...'⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ'][i]!]));
const subscripts = Object.fromEntries([...'0123456789+-=()aehijklmnoprstuvx'].map((c, i) => [c, [...'₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ'][i]!]));

function script(text: string, sub: boolean): string {
  const alphabet = sub ? subscripts : superscripts;
  return [...text].every(c => alphabet[c]) ? [...text].map(c => alphabet[c]).join('') : `${sub ? '_' : '^'}(${text})`;
}

function readable(node: MmlNode): string {
  if (node instanceof TextNode) return node.getText();
  const children = node.childNodes.map(readable);
  const [a = '', b = '', c = ''] = children;
  let base = node.childNodes[0];
  while (base && ['TeXAtom', 'mrow', 'inferredMrow', 'mstyle'].includes(base.kind) && base.childNodes.length === 1) base = base.childNodes[0];
  const grouped = base && !base.isToken && base.childNodes.length > 1 ? `(${a})` : a;
  switch (node.kind) {
    case 'mfrac': return `(${a})/(${b})`;
    case 'msqrt': return `√(${children.join('')})`;
    case 'mroot': return `root(${b}, ${a})`;
    case 'msup': return `${grouped}${script(b, false)}`;
    case 'msub': return `${grouped}${script(b, true)}`;
    case 'msubsup': return `${grouped}${script(b, true)}${script(c, false)}`;
    case 'munder': return `${a}_(${b})`;
    case 'mover': return `${a}^(${b})`;
    case 'munderover': return `${a}_(${b})^(${c})`;
    case 'mtable': return `[${children.join('; ')}]`;
    case 'mtr': case 'mlabeledtr': return children.join(', ');
    case 'mspace': return ' ';
    case 'mphantom': return '';
    case 'math': case 'mrow': case 'inferredMrow': case 'TeXAtom': case 'mstyle':
    case 'mi': case 'mn': case 'mo': case 'mtext': case 'mtd': return children.join('');
    default: throw new Error(`Unsupported terminal math node: ${node.kind}`);
  }
}

/** Convert one TeX expression, without extension autoloads, network access or shared macro state.
 * @param source - TeX without delimiters.
 * @param display - Block rather than inline mathematics.
 * @returns Unicode approximation and MathJax-generated MathML, or undefined for invalid TeX.
 */
export function renderMath(source: string, display: boolean): { text: string; html: string } | undefined {
  if (source.length > 16 * 1024) return undefined;
  try {
    const tex = new TeX({ packages: ['base', 'ams'], maxBuffer: 16 * 1024,
      formatError(_jax: unknown, error: Error) { throw error; } });
    const document = mathjax.document('', { InputJax: tex });
    const node = document.convert(source, { display, end: STATE.CONVERT }) as MmlNode;
    const html = new SerializedMmlVisitor().visitTree(node);
    let text: string;
    try { text = readable(node); }
    catch { text = source; /* Valid MathML with no faithful terminal notation retains its TeX. */ }
    return { text: safeText(text), html };
  } catch { return undefined; /* Incomplete or invalid model-authored TeX remains visible as source. */ }
}
