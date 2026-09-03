/**
 * Secure, lightweight Markdown-to-HTML parser for synthesized AI answers.
 * Sanitizes input to prevent XSS and renders headings, lists, code, emphasis,
 * blockquotes, horizontal rules, and interactive citation badges like [C1].
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderInline(text: string): string {
  // 1. Inline code: `code`
  let result = text.replace(/`([^`]+)`/g, (_match, code) => {
    return `<code class="md-inline-code">${escapeHtml(code)}</code>`;
  });

  // 2. Citation badges: [C1], [C2], etc.
  result = result.replace(/\[(C\d+)\]/g, (_match, citationId) => {
    return `<a href="#citation-${citationId}" class="md-citation-badge" data-citation-id="${citationId}">[${citationId}]</a>`;
  });

  // 3. Bold: **text** or __text__
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // 4. Italic: *text* or _text_
  result = result.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
  result = result.replace(/(^|[^_])_([^_]+)_([^_]|$)/g, '$1<em>$2</em>$3');

  return result;
}

export function renderMarkdown(markdown: string): string {
  if (!markdown || typeof markdown !== 'string') return '';

  const rawLines = markdown.split(/\r?\n/);
  const htmlParts: string[] = [];

  let inCodeBlock = false;
  let codeBlockLang = '';
  let codeBlockBuffer: string[] = [];

  let inList: 'ul' | 'ol' | null = null;

  function closeList() {
    if (inList) {
      htmlParts.push(`</${inList}>`);
      inList = null;
    }
  }

  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i] ?? '';

    // Handle fenced code blocks: ```lang ... ```
    const codeBlockMatch = rawLine.match(/^```(\w*)/);
    if (codeBlockMatch) {
      if (!inCodeBlock) {
        closeList();
        inCodeBlock = true;
        codeBlockLang = codeBlockMatch[1] ?? '';
        codeBlockBuffer = [];
      } else {
        inCodeBlock = false;
        const codeContent = escapeHtml(codeBlockBuffer.join('\n'));
        const langAttr = codeBlockLang ? ` data-language="${escapeHtml(codeBlockLang)}"` : '';
        htmlParts.push(`<pre class="md-code-block"${langAttr}><code>${codeContent}</code></pre>`);
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockBuffer.push(rawLine);
      continue;
    }

    const trimmed = rawLine.trim();

    // Blank line
    if (trimmed.length === 0) {
      closeList();
      continue;
    }

    // Horizontal Rule: --- or ***
    if (/^(?:---|\*\*\*|___)$/.test(trimmed)) {
      closeList();
      htmlParts.push('<hr class="md-divider" />');
      continue;
    }

    // Headings: # H1, ## H2, ### H3, #### H4
    const headingMatch = rawLine.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1]?.length ?? 2;
      const content = renderInline(escapeHtml(headingMatch[2]?.trim() ?? ''));
      // In the context of the answer card (which has an h3), h2->h3, h3->h4, etc.
      const tag = level === 1 ? 'h3' : level === 2 ? 'h3' : level === 3 ? 'h4' : 'h5';
      htmlParts.push(`<${tag} class="md-heading md-heading-${level}">${content}</${tag}>`);
      continue;
    }

    // Blockquotes: > quote
    if (trimmed.startsWith('>')) {
      closeList();
      const quoteText = renderInline(escapeHtml(trimmed.replace(/^>\s*/, '')));
      htmlParts.push(`<blockquote class="md-blockquote">${quoteText}</blockquote>`);
      continue;
    }

    // Unordered list: - item or * item
    const ulMatch = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        inList = 'ul';
        htmlParts.push('<ul class="md-list md-unordered">');
      }
      const itemText = renderInline(escapeHtml(ulMatch[1] ?? ''));
      htmlParts.push(`<li>${itemText}</li>`);
      continue;
    }

    // Ordered list: 1. item
    const olMatch = rawLine.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        inList = 'ol';
        htmlParts.push('<ol class="md-list md-ordered">');
      }
      const itemText = renderInline(escapeHtml(olMatch[1] ?? ''));
      htmlParts.push(`<li>${itemText}</li>`);
      continue;
    }

    // Regular paragraph
    closeList();
    const paragraphText = renderInline(escapeHtml(trimmed));
    htmlParts.push(`<p class="md-paragraph">${paragraphText}</p>`);
  }

  closeList();

  if (inCodeBlock) {
    const codeContent = escapeHtml(codeBlockBuffer.join('\n'));
    htmlParts.push(`<pre class="md-code-block"><code>${codeContent}</code></pre>`);
  }

  return htmlParts.join('\n');
}
