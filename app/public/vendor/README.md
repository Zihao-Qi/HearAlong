# Vendored browser libraries

Served locally, so the app needs no network at runtime. Licenses: marked is MIT; DOMPurify is MPL-2.0 OR Apache-2.0.

| File | Package | Source |
|---|---|---|
| `marked-15.0.12.umd.js` | marked 15.0.12 | `npm pack marked@15.0.12`, `lib/marked.umd.js` |
| `purify-3.2.6.min.js` | DOMPurify 3.2.6 | `npm pack dompurify@3.2.6`, `dist/purify.min.js` |
| `katex-0.16.22.min.js` | KaTeX 0.16.22 (MIT) | `npm pack katex@0.16.22`, `dist/katex.min.js` |

They render answer-card Markdown (M3): `DOMPurify.sanitize(marked.parse(text))`. KaTeX renders `\( \)`, `\[ \]` and `$$ $$` formulas as native MathML (`output: 'mathml'`): no fonts, CSS or inline styles, so the page's `style-src 'self'` policy holds.
