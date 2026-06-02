/**
 * Markdown utility for Feishu card output.
 *
 * Simplified from upstream `src/feishu/markdown.ts`:
 * - clean HTML tags (保护代码块内的 Map<string, number> 泛型语法)
 * - close unclosed code fences
 * - UTF-8 safe truncation to limit bytes
 */

const HTML_TAG_RE = /<\/?\w+(?:\s[^>]*)?\/?>/g
const CODE_FENCE_RE = /^\s*`{3,}.*$/gm
const FENCE_RE = /(`{3,})([\s\S]*?)\1/g

export function cleanMarkdown(text: string): string {
  let result = text.replace(/<br\s*\/?>/gi, "\n")
  result = closeCodeBlocks(result)
  const segments: string[] = []
  const blocks: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  FENCE_RE.lastIndex = 0
  while ((m = FENCE_RE.exec(result)) !== null) {
    segments.push(result.slice(last, m.index))
    blocks.push(m[0])
    last = m.index + m[0].length
  }
  segments.push(result.slice(last))
  result = segments.reduce((acc, seg, i) => acc + seg.replace(HTML_TAG_RE, "") + (blocks[i] ?? ""), "")
  return closeCodeBlocks(result)
}

function closeCodeBlocks(text: string): string {
  const matches = text.match(CODE_FENCE_RE)
  if (matches && matches.length % 2 !== 0) return text + "\n```"
  return text
}

const DEFAULT_LIMIT = 6 * 1024
const TRUNCATION_SUFFIX = "\n\n*内容过长，已截断*"

export function truncateMarkdown(text: string, limit = DEFAULT_LIMIT): string {
  const cleaned = cleanMarkdown(text)
  const bytes = new TextEncoder().encode(cleaned)
  if (bytes.length <= limit) return cleaned
  const suffixBytes = new TextEncoder().encode(TRUNCATION_SUFFIX).length
  const fenceBytes = 4
  const effective = limit - suffixBytes - fenceBytes
  if (effective <= 0) return TRUNCATION_SUFFIX
  const truncated = new TextDecoder().decode(bytes.slice(0, effective))
  const lastNewline = truncated.lastIndexOf("\n")
  const cut = lastNewline > effective * 0.8 ? lastNewline : truncated.length
  return closeCodeBlocks(truncated.slice(0, cut)) + TRUNCATION_SUFFIX
}
