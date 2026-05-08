export const LONG_CONTEXT_CHARS = 120_000;

export const SIMPLE_PATTERNS = [
  /\btranslate\b/i,
  /\bsummarize\b/i,
  /\bformat\b/i,
  /\bexplain briefly\b/i,
  /翻译/,
  /总结/,
  /格式化/,
];

export const CODE_PATTERNS = [
  /\btypescript\b/i,
  /\bjavascript\b/i,
  /\bfunction\b/i,
  /\bclass\b/i,
  /\bwrite\s+(some\s+)?code\b/i,
  /\bgenerate\s+code\b/i,
  /\bimplement\b/i,
  /代码/,
  /函数/,
];

export const COMPLEX_PATTERNS = [
  /\bdebug\b/i,
  /\bfailing tests?\b/i,
  /\barchitecture\b/i,
  /\brefactor\b/i,
  /\bmultiple files?\b/i,
  /\broot cause\b/i,
  /调试/,
  /测试失败/,
  /架构/,
  /重构/,
  /多文件/,
];
