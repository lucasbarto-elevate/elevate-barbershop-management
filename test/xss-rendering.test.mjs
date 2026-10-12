import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const functionSource = (name) => {
  const match = html.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, 'm'));
  assert.ok(match, `Expected ${name} helper in index.html`);
  return match[0];
};

test('untrusted template values stay out of parser markup and become text nodes', () => {
  const payload = '<img src=x onerror="globalThis.xssExecuted=true"><script>globalThis.xssExecuted=true</script>';
  const textValues = [];
  class TestNode {}
  const context = vm.createContext({
    Node: TestNode,
    document: { createTextNode: (value) => { textValues.push(value); return { nodeType: 3, textContent: value }; } }
  });
  vm.runInContext(`${functionSource('safeHTMLMarkup')}\n${functionSource('appendSafeHTMLValue')}`, context);

  const markup = vm.runInContext("safeHTMLMarkup(['<p>', '</p>'], ['__VALUE_SLOT__'])", context);
  vm.runInContext('appendSafeHTMLValue({ append(node) { globalThis.renderedNode = node; } }, payload)', Object.assign(context, { payload }));

  assert.equal(markup, '<p><!--__VALUE_SLOT__--></p>');
  assert.equal(markup.includes(payload), false);
  assert.equal(textValues[0], payload);
  assert.equal(context.renderedNode.nodeType, 3);
  assert.equal(context.renderedNode.textContent, payload);
  assert.equal(context.xssExecuted, undefined);
});

test('dynamic rendering has no HTML sinks beyond the static-template parser', () => {
  const sinks = [...html.matchAll(/(?:\.innerHTML\s*=|\.outerHTML\s*=|\.insertAdjacentHTML\s*\(|document\.write\s*\()/g)];
  assert.equal(sinks.length, 1, 'Only safeHTML may parse its controlled template markup');
  assert.match(sinks[0][0], /\.innerHTML\s*=/);
  assert.match(html, /template\.innerHTML=markup; \/\/ Only literal markup and generated markers reach the HTML parser\./);
  assert.match(html, /parent\.append\(document\.createTextNode\(String\(value\)\)\)/);
});

test('single-element templates return safe elements for DOM properties and insertion', () => {
  const inserted = [];
  class TestNode {}
  class TestElement extends TestNode {
    constructor() {
      super();
      this.dataset = {};
      this.classList = { toggle: (name, active) => { this.toggled = [name, active]; } };
    }
  }
  const element = new TestElement();
  const fragment = { childNodes: [element], firstChild: element };
  const context = vm.createContext({
    Node: TestNode,
    Element: TestElement,
    safeHTMLFragments: new WeakSet(),
    safeHTML: () => fragment,
    document: { createTextNode: (value) => ({ nodeType: 3, textContent: value }) }
  });
  vm.runInContext(`${functionSource('safeHTMLSingleElement')}\n${functionSource('appendSafeHTMLValue')}`, context);

  vm.runInContext(`const node=safeHTMLSingleElement(['<button>', '</button>'], 'label');
    node.dataset.id='barber-1'; node.classList.toggle('selected', true);
    appendSafeHTMLValue({ append(value) { globalThis.inserted=value; } }, node);`, context);

  assert.strictEqual(context.inserted, element);
  assert.equal(element.dataset.id, 'barber-1');
  assert.deepEqual(element.toggled, ['selected', true]);

  context.safeHTML = () => ({ childNodes: [], firstChild: null });
  assert.throws(() => vm.runInContext("safeHTMLSingleElement(['<div></div>'])", context), /exatamente um elemento/);
});

test('dashboard and barber startup use safe single elements wherever they mutate element state', () => {
  const render = functionSource('render');
  const ipad = functionSource('renderIpad');
  const cash = functionSource('renderCash');

  assert.match(render, /renderIpad\(\);renderDashboard\(\)/);
  assert.match(ipad, /safeHTMLSingleElement`<button class="card"/);
  assert.match(ipad, /safeHTMLSingleElement`<div class="card select-card"/);
  assert.match(cash, /safeHTMLSingleElement`<button type="button" class="card cash-filter-card"/);
  assert.match(html, /navInit\(\);render\(\);applyHostMode\(\);/);
  assert.match(html, /case 'nav': if\(page==='ipad'\)openBarberPage\(\)/);
});

test('barber area opens the shared app without serializing current DOM as HTML', () => {
  assert.match(html, /new URLSearchParams\(window\.location\.search\)\.get\('barber'\)==='1'/);
  assert.match(html, /url\.searchParams\.set\('barber','1'\)/);
  assert.doesNotMatch(html, /document\.write\s*\(/);
});
