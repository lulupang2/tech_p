/**
 * HTML and text sanitizer for Signal Archive data pipeline.
 *
 * Implements strict removal of:
 * - Executable / embeddable elements: <script>, <style>, <iframe>, <object>, <embed>, <applet>, <noscript>, <template>, <svg>, <canvas>, <audio>, <video>, <frame>, <frameset>, <link>, <meta>
 * - Hidden elements: attributes `hidden`, `aria-hidden="true"`, and CSS styles containing `display: none`, `visibility: hidden`, `opacity: 0`, `font-size: 0`, `height: 0`, `width: 0`, negative off-screen positioning.
 * - Prompt injection and system instruction tags: <system>, <instruction>, <instructions>, <prompt>, <secret>, <tool>, <context>, <admin>, <override>, <assistant>, <system-reminder>, <system-directive>, <user-directive>, <hidden-instruction>, etc.
 * - Zero-width and control characters.
 * - Event handler attributes (onclick, onload, onerror, etc.).
 *
 * Enforces plain-text extraction with deterministic formatting per DATA_PIPELINE.md §5.4 and SECURITY.md §4.3, §8.
 */

export const SANITIZER_VERSION = 'v1.0.0' as const;

/**
 * Common HTML entities and numeric references decoder.
 */
export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text;

  const namedEntities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&ensp;': ' ',
    '&emsp;': ' ',
    '&thinsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&bull;': '•',
    '&middot;': '·',
    '&lsaquo;': '‹',
    '&rsaquo;': '›',
    '&laquo;': '«',
    '&raquo;': '»',
    '&ldquo;': '"',
    '&rdquo;': '"',
    '&lsquo;': "'",
    '&rsquo;': "'",
  };

  let decoded = text;
  for (const [entity, replacement] of Object.entries(namedEntities)) {
    if (decoded.includes(entity)) {
      decoded = decoded.replaceAll(entity, replacement);
    }
  }

  // Handle decimal entity references: &#123;
  decoded = decoded.replace(/&#(\d+);/gu, (_, dec) => {
    try {
      const code = parseInt(dec, 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  });

  // Handle hex entity references: &#x1f4a9;
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/gu, (_, hex) => {
    try {
      const code = parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  });

  return decoded;
}

/**
 * Strips zero-width characters, non-printable control characters, and dangerous invisible unicode
 * via char-code iteration to avoid regex control-character lint violations.
 */
export function stripInvisibleCharacters(text: string): string {
  let result = '';
  for (const char of text) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;

    // Zero-width space (0x200B), zero-width non-joiner (0x200C), zero-width joiner (0x200D),
    // word joiner (0x2060), BOM (0xFEFF), soft hyphen (0x00AD)
    if (
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      cp === 0x2060 ||
      cp === 0xfeff ||
      cp === 0x00ad
    ) {
      continue;
    }

    // Keep standard whitespace (tab 0x09, newline 0x0A, carriage return 0x0D)
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) {
      result += char;
      continue;
    }

    // Skip C0 control characters (0x00 - 0x1F)
    if (cp >= 0x00 && cp <= 0x1f) {
      continue;
    }

    // Skip Delete and C1 control characters (0x7F - 0x9F)
    if (cp >= 0x7f && cp <= 0x9f) {
      continue;
    }

    result += char;
  }

  return result;
}

/**
 * Dangerous tag names whose entire contents must be discarded.
 */
const DANGEROUS_TAGS: Record<string, true> = {
  script: true,
  style: true,
  iframe: true,
  object: true,
  embed: true,
  applet: true,
  noscript: true,
  noembed: true,
  template: true,
  svg: true,
  canvas: true,
  audio: true,
  video: true,
  frame: true,
  frameset: true,
  link: true,
  meta: true,
  head: true,
  title: true,
};

/**
 * System and prompt injection instruction tag names whose entire contents must be discarded.
 */
const INSTRUCTION_TAGS: Record<string, true> = {
  system: true,
  instruction: true,
  instructions: true,
  prompt: true,
  secret: true,
  tool: true,
  context: true,
  admin: true,
  override: true,
  assistant: true,
  'system-reminder': true,
  'system-directive': true,
  'user-directive': true,
  'hidden-instruction': true,
  'prompt-injection': true,
  injection: true,
};

/**
 * Block elements that should produce line breaks in plain text output.
 */
const BLOCK_TAGS: Record<string, true> = {
  p: true,
  div: true,
  h1: true,
  h2: true,
  h3: true,
  h4: true,
  h5: true,
  h6: true,
  li: true,
  tr: true,
  blockquote: true,
  section: true,
  article: true,
  header: true,
  footer: true,
  nav: true,
  aside: true,
  main: true,
  pre: true,
  address: true,
  figure: true,
  figcaption: true,
  hr: true,
  br: true,
};

/**
 * Void elements that do not have closing tags.
 */
const VOID_TAGS: Record<string, true> = {
  area: true,
  base: true,
  br: true,
  col: true,
  embed: true,
  hr: true,
  img: true,
  input: true,
  link: true,
  meta: true,
  param: true,
  source: true,
  track: true,
  wbr: true,
};

/**
 * Checks if attribute string indicates a hidden element.
 */
function isElementHidden(attrs: Record<string, string>): boolean {
  // 1. Explicit hidden attribute
  if ('hidden' in attrs) {
    const val = attrs['hidden']?.toLowerCase();
    if (val === '' || val === 'hidden' || val === 'true') {
      return true;
    }
  }

  // 2. aria-hidden attribute
  if (attrs['aria-hidden']?.toLowerCase() === 'true') {
    return true;
  }

  // 3. CSS style properties that hide elements
  const style = attrs['style']?.toLowerCase();
  if (style) {
    if (
      /display\s*:\s*none/u.test(style) ||
      /visibility\s*:\s*hidden/u.test(style) ||
      /opacity\s*:\s*0(?:\.0+)?(?![0-9.])/u.test(style) ||
      /font-size\s*:\s*0(?:px|em|rem|pt|%)?/u.test(style) ||
      /height\s*:\s*0(?:px|em|rem|pt|%)?/u.test(style) ||
      /width\s*:\s*0(?:px|em|rem|pt|%)?/u.test(style) ||
      /max-height\s*:\s*0(?:px|em|rem|pt|%)?/u.test(style) ||
      /max-width\s*:\s*0(?:px|em|rem|pt|%)?/u.test(style) ||
      /position\s*:\s*absolute\s*;\s*left\s*:\s*-\d+/u.test(style) ||
      /left\s*:\s*-(?:999|9999|10000)px/u.test(style) ||
      /top\s*:\s*-(?:999|9999|10000)px/u.test(style) ||
      /text-indent\s*:\s*-(?:999|9999|10000)px/u.test(style)
    ) {
      return true;
    }
  }

  // 4. Hidden or screen-reader only class patterns commonly used to hide content from visual users
  const className = attrs['class']?.toLowerCase();
  if (className) {
    if (
      /\b(?:hidden|d-none|invisible|visually-hidden|sr-only|hide|is-hidden)\b/u.test(className) &&
      !/\b(?:not-hidden|show|visible)\b/u.test(className)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Parses raw HTML attribute string into a key-value record.
 */
function parseHtmlAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(attrString)) !== null) {
    const key = match[1]?.toLowerCase();
    if (!key) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[key] = value;
  }

  return attrs;
}

interface ParsedNode {
  readonly tag: string | null;
  readonly isBlock: boolean;
  readonly isHidden: boolean;
  readonly isDangerous: boolean;
  readonly text?: string;
  readonly children: ParsedNode[];
}

/**
 * Lightweight deterministic DOM tree builder for HTML sanitization.
 */
function parseHtmlToTree(html: string): ParsedNode {
  // Pre-strip HTML comments to prevent nested injection bypasses
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/gu, ' ');

  const root: ParsedNode = {
    tag: null,
    isBlock: true,
    isHidden: false,
    isDangerous: false,
    children: [],
  };

  const stack: ParsedNode[] = [root];
  let cursor = 0;
  const len = cleanHtml.length;

  const tagRegex = /<(\/)?([a-zA-Z0-9_:-]+)([^>]*)>/gu;
  let match: RegExpExecArray | null;

  while (cursor < len && (match = tagRegex.exec(cleanHtml)) !== null) {
    const textBefore = cleanHtml.slice(cursor, match.index);
    if (textBefore) {
      const current = stack[stack.length - 1];
      if (current && !current.isHidden && !current.isDangerous) {
        current.children.push({
          tag: null,
          isBlock: false,
          isHidden: false,
          isDangerous: false,
          text: textBefore,
          children: [],
        });
      }
    }

    cursor = tagRegex.lastIndex;

    const isClosing = Boolean(match[1]);
    const tagName = (match[2] ?? '').toLowerCase();
    const attrString = match[3] ?? '';
    const isSelfClosing = attrString.trimEnd().endsWith('/') || VOID_TAGS[tagName] === true;

    if (isClosing) {
      // Find matching tag on stack
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]?.tag === tagName) {
          stack.splice(i);
          break;
        }
      }
    } else {
      const attrs = parseHtmlAttributes(attrString);
      const isDangerous = DANGEROUS_TAGS[tagName] === true || INSTRUCTION_TAGS[tagName] === true;
      const parentIsHidden = stack.some((node) => node.isHidden || node.isDangerous);
      const isHidden = parentIsHidden || isDangerous || isElementHidden(attrs);
      const isBlock = BLOCK_TAGS[tagName] === true;

      const node: ParsedNode = {
        tag: tagName,
        isBlock,
        isHidden,
        isDangerous,
        children: [],
      };

      const current = stack[stack.length - 1];
      if (current) {
        current.children.push(node);
      }

      if (!isSelfClosing) {
        stack.push(node);
      }
    }
  }

  const remainingText = cleanHtml.slice(cursor);
  if (remainingText) {
    const current = stack[stack.length - 1];
    if (current && !current.isHidden && !current.isDangerous) {
      current.children.push({
        tag: null,
        isBlock: false,
        isHidden: false,
        isDangerous: false,
        text: remainingText,
        children: [],
      });
    }
  }

  return root;
}

/**
 * Recursively extracts plain text from a parsed DOM tree.
 */
function extractTextFromTree(node: ParsedNode, pieces: string[]): void {
  if (node.isHidden || node.isDangerous) {
    return;
  }

  if (node.text !== undefined) {
    pieces.push(node.text);
    return;
  }

  if (node.tag === 'br') {
    pieces.push('\n');
    return;
  }

  if (node.tag === 'hr') {
    pieces.push('\n---\n');
    return;
  }

  if (node.tag === 'li') {
    pieces.push('\n• ');
  } else if (node.isBlock && node.tag !== null) {
    pieces.push('\n');
  }

  for (const child of node.children) {
    extractTextFromTree(child, pieces);
  }

  if (node.isBlock && node.tag !== null) {
    pieces.push('\n');
  }
}

/**
 * Sanitizes arbitrary HTML input, removing all script, style, iframe, hidden elements,
 * instruction tags, and dangerous markup, returning clean, decoded, formatted plain text.
 */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // 1. If the input does not look like HTML, sanitize as text directly
  if (!html.includes('<') && !html.includes('&')) {
    return sanitizeText(html);
  }

  // 2. Parse HTML into node tree and prune hidden/dangerous subtrees
  const tree = parseHtmlToTree(html);
  const pieces: string[] = [];
  extractTextFromTree(tree, pieces);

  // 3. Decode HTML entities and strip invisible / control characters
  const rawText = pieces.join('');
  const decoded = decodeHtmlEntities(rawText);
  return sanitizeText(decoded);
}

/**
 * Sanitizes plain text by removing invisible control characters, decoding HTML entities,
 * neutralizing dangerous HTML tags and prompt injection bracket markers, and normalizing whitespace.
 */
export function sanitizeText(text: string | null | undefined): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // 1. Strip zero-width & non-printable control characters
  let cleaned = stripInvisibleCharacters(text);

  // 2. If text contains HTML tags, remove dangerous script/style/iframe/etc. tags and contents
  if (cleaned.includes('<')) {
    // Remove HTML comments
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/gu, ' ');

    // Remove script, style, iframe, object, embed, noscript and their contents
    cleaned = cleaned.replace(
      /<(?:script|style|iframe|object|embed|applet|noscript|template|svg|canvas|audio|video|frame|frameset|link|meta|head)[\s\S]*?<\/(?:script|style|iframe|object|embed|applet|noscript|template|svg|canvas|audio|video|frame|frameset|link|meta|head)>/giu,
      ' ',
    );
    // Remove self-closing or unclosed dangerous tags
    cleaned = cleaned.replace(
      /<(?:script|style|iframe|object|embed|applet|noscript|template|svg|canvas|audio|video|frame|frameset|link|meta|head)[^>]*\/?>/giu,
      ' ',
    );

    // Remove elements with hidden / display:none / opacity:0 attributes
    cleaned = cleaned.replace(
      /<(?:[a-zA-Z0-9_:-]+)\s+[^>]*(?:hidden|aria-hidden\s*=\s*["']?true["']?|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0|font-size\s*:\s*0)[^"']*["'])[^>]*>[\s\S]*?<\/(?:[a-zA-Z0-9_:-]+)>/giu,
      ' ',
    );

    // Neutralize instruction / prompt injection XML-like tags with their contents
    cleaned = cleaned.replace(
      /<(?:system|instruction|instructions|prompt|secret|tool|context|admin|override|assistant|system-reminder|system-directive|user-directive|hidden-instruction|prompt-injection|injection)[\s\S]*?<\/(?:system|instruction|instructions|prompt|secret|tool|context|admin|override|assistant|system-reminder|system-directive|user-directive|hidden-instruction|prompt-injection|injection)>/giu,
      ' ',
    );

    // Strip remaining prompt injection standalone tags
    const injectionTagPattern =
      /<\/?(?:system|instruction|instructions|prompt|secret|tool|context|admin|override|assistant|system-reminder|system-directive|user-directive|hidden-instruction|prompt-injection|injection)[^>]*>/giu;
    cleaned = cleaned.replace(injectionTagPattern, '');
  }

  // 2.1 Strip special LLM injection tokens and bracketed role overrides
  cleaned = cleaned.replace(
    /<\|(?:im_start|im_end|endoftext|system|user|assistant|fim_prefix|fim_suffix|fim_middle)\|>/giu,
    ' ',
  );
  cleaned = cleaned.replace(/<<(?:SYS|\/SYS)>>/giu, ' ');
  cleaned = cleaned.replace(/\[\/?(?:SYSTEM|INSTRUCTION|ADMIN|OVERRIDE|SYSTEM_PROMPT)\]/giu, ' ');

  // 3. Decode HTML entities (e.g. &amp; -> &, &lt; -> <, &#39; -> ', etc.)
  cleaned = decodeHtmlEntities(cleaned);

  // 4. Normalize newline sequences (\r\n -> \n, \r -> \n)
  cleaned = cleaned.replace(/\r\n|\r/gu, '\n');

  // 5. Normalize spaces/tabs on each line
  const lines = cleaned.split('\n').map((line) => {
    // Replace tabs and multiple spaces with a single space, trim margins
    return line.replace(/[ \t]+/gu, ' ').trim();
  });

  // 6. Collapse multiple blank lines (max 2 newlines in sequence)
  const resultLines: string[] = [];
  let blankCount = 0;

  for (const line of lines) {
    if (line.length === 0) {
      blankCount++;
      if (blankCount <= 1 && resultLines.length > 0) {
        resultLines.push('');
      }
    } else {
      blankCount = 0;
      resultLines.push(line);
    }
  }

  return resultLines.join('\n').trim();
}
