// Small DOM double for the plain-JS view tests. Selectors cover the views' own focus/menu lookups.
export type UIEvent = { key?: string; target?: Element; preventDefault(): void; stopPropagation(): void; composedPath(): Element[] };
export class Element {
  tagName: string;
  textContent: string;
  className: string;
  hidden = false; open = false; disabled = false; tabIndex = 0; href = '#'; title = ''; id = ''; innerHTML = '';
  dataset: Record<string, string> = {};
  children: Element[] = [];
  attributes: Record<string, string> = {};
  listeners: Record<string, (event: UIEvent) => void> = {};
  onclick?: (event?: UIEvent) => unknown;
  onkeydown?: (event: UIEvent) => void;
  onFocus = () => {};
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); },
    remove: (name: string) => { this.className = this.className.split(' ').filter(n => n !== name).join(' '); },
    toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name); },
    contains: (name: string) => this.className.split(' ').includes(name),
  };
  constructor(tag: string, text = '', className = '') { this.tagName = tag.toUpperCase(); this.textContent = text; this.className = className; }
  append(...children: (Element | string)[]) { this.children.push(...children.map(c => typeof c === 'string' ? new Element('#text', c) : c)); }
  prepend(...children: Element[]) { this.children.unshift(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name]; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, fn: (event: UIEvent) => void) { this.listeners[name] = fn; }
  insertAdjacentHTML(_where: string, html: string) { this.innerHTML += html; }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const present = /^\[([^=]+)\]$/.exec(selector);
    if (present) return present[1].startsWith('data-') ? present[1].slice(5) in this.dataset : present[1] in this.attributes;
    const attr = /^\[([^=]+)="([^"]*)"\]$/.exec(selector);
    if (attr) return (attr[1].startsWith('data-') ? this.dataset[attr[1].slice(5)] : this.attributes[attr[1]]) === attr[2];
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector = '[role="menuitem"]'): Element[] { return this.children.flatMap(c => [...(c.matches(selector) ? [c] : []), ...c.querySelectorAll(selector)]); }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  contains(node?: Element | null): boolean { return node === this || this.children.some(c => c.contains(node)); }
  focus() { this.onFocus(); }
  click() { return this.onclick?.(); }
  closest(selector: string) { return this.matches(selector) ? this : null; }
}
export const words = (node: Element): string => [node.textContent, ...node.children.map(words)].filter(Boolean).join(' ');
export const event = (key?: string, target?: Element): UIEvent => ({ key, target, preventDefault() {}, stopPropagation() {}, composedPath: () => target ? [target] : [] });
