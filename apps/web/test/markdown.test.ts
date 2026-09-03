import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';

describe('renderMarkdown', () => {
  test('returns empty string on empty input', () => {
    assert.equal(renderMarkdown(''), '');
  });

  test('escapes raw HTML to prevent XSS attacks', () => {
    const raw = '<script>alert("xss")</script> <b>bold</b>';
    const html = renderMarkdown(raw);
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('renders headings appropriately', () => {
    const md = '## 주요 릴리스 동향\n### 세부 사항';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<h3 class="md-heading md-heading-2">주요 릴리스 동향</h3>'));
    assert.ok(html.includes('<h4 class="md-heading md-heading-3">세부 사항</h4>'));
  });

  test('renders unordered lists', () => {
    const md = '- 항목 1\n- 항목 2\n- 항목 3';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<ul class="md-list md-unordered">'));
    assert.ok(html.includes('<li>항목 1</li>'));
    assert.ok(html.includes('<li>항목 2</li>'));
    assert.ok(html.includes('</ul>'));
  });

  test('renders ordered lists', () => {
    const md = '1. 첫 번째\n2. 두 번째';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<ol class="md-list md-ordered">'));
    assert.ok(html.includes('<li>첫 번째</li>'));
    assert.ok(html.includes('<li>두 번째</li>'));
    assert.ok(html.includes('</ol>'));
  });

  test('converts citation markers [C1], [C2] into clickable anchor badges', () => {
    const md = 'Bun 1.1이 발표되었습니다 [C1]. Node.js 지원 정책도 확인됩니다 [C2].';
    const html = renderMarkdown(md);
    assert.ok(html.includes('href="#citation-C1"'));
    assert.ok(html.includes('class="md-citation-badge"'));
    assert.ok(html.includes('data-citation-id="C1"'));
    assert.ok(html.includes('[C1]</a>'));
    assert.ok(html.includes('href="#citation-C2"'));
  });

  test('renders bold, italic, and inline code', () => {
    const md = '**중요** 내용과 *참고* 사항 및 `npm install bun` 명령어.';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<strong>중요</strong>'));
    assert.ok(html.includes('<em>참고</em>'));
    assert.ok(html.includes('<code class="md-inline-code">npm install bun</code>'));
  });

  test('renders fenced code blocks', () => {
    const md = '```ts\nconst x: number = 42;\nconsole.log(x);\n```';
    const html = renderMarkdown(md);
    assert.ok(html.includes('<pre class="md-code-block" data-language="ts"><code>'));
    assert.ok(html.includes('const x: number = 42;'));
    assert.ok(html.includes('</code></pre>'));
  });
});
