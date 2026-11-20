// Gradle / javac 失败摘要：只留前 3 条「文件:行 + 错误消息」与错误总数。
// 以前构建失败会把日志最后 8000 字符整段丢给模型，首个编译错误往往在更靠前的位置，模型看不到只能盲试。
//
// 这里是纯函数（无 fs / 无插件注册副作用），既被 index.ts 的 mc_gradle 调用，
// 也可以直接 `npx tsx -e "import { summarizeGradleErrors } from './plugins/mcdev/error-summary.ts' ..."` 验证。

export interface GradleErrorItem {
  /** 文件:行（javac 带列号时为 文件:行:列） */
  location: string
  /** 错误消息（error 行本身） */
  message: string
  /** javac 跟随行里的 symbol / location / required / found 等补充信息（最多 2 条） */
  detail?: string
}

export interface GradleErrorSummary {
  /** 错误总数：优先取 javac 的「N errors / N 个错误」，否则按匹配到的错误行计数 */
  total: number
  /** 前 3 条错误（total 可能大于它的长度） */
  errors: GradleErrorItem[]
  /** 组装好的摘要文本（无错误时为空串），长度约 2000 字符以内 */
  text: string
}

const MAX_ERRORS = 3
const MAX_TEXT = 2000

/**
 * Java/Kotlin 编译错误行。兼容：
 * - `C:\proj\src\Foo.java:42: error: cannot find symbol`
 * - `src/main/java/com/x/Foo.java:42: 错误: 找不到符号`
 * - 带列号 `Foo.java:42:7: error: ...`
 */
const JAVA_ERROR_RE = /^\s*(.+?\.(?:java|kt)):(\d+)(?::(\d+))?:\s*(?:error|错误)\s*[:：]\s*(.*)$/i

/** Gradle 脚本错误：`Build file 'C:\proj\build.gradle' line: 23` / `构建文件 '...' 行: 23` */
const GRADLE_SCRIPT_RE = /^\s*(?:Build file|构建文件)\s*'([^']+)'\s*(?:line|行)\s*[:：]\s*(\d+)/i

/** javac 的补充行：`  symbol:   variable foo` / `  required: ...` */
const DETAIL_RE = /^\s{2,}(symbol|location|required|found|reason)\s*[:：]\s*(.+)$/i

/** 错误总数为单独一行时：`3 errors` / `3 个错误` */
const TOTAL_RE = /^(\d+)\s+(?:errors?|个错误)\s*$/gim

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** 长 Windows 路径保留尾部：包名/文件名比盘符前缀更有用 */
function clipPath(p: string): string {
  return p.length > 160 ? `…${p.slice(-160)}` : p
}

/**
 * 从 Gradle 输出提取编译错误摘要。
 * 返回的对象里 errors 是前 3 条，total 是错误总数，text 是可以直接给模型的摘要文本。
 */
export function summarizeGradleErrors(text: string): GradleErrorSummary {
  const src = String(text ?? '')
  const lines = src.split(/\r?\n/)
  const errors: GradleErrorItem[] = []
  let matched = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let file = ''
    let lineNo = ''
    let col = ''
    let message = ''

    const m = JAVA_ERROR_RE.exec(line)
    if (m) {
      file = m[1].trim()
      lineNo = m[2]
      col = m[3] ?? ''
      message = m[4] ?? ''
    } else {
      const g = GRADLE_SCRIPT_RE.exec(line)
      if (g) {
        file = g[1].trim()
        lineNo = g[2]
        message = 'Gradle 脚本错误（原因见构建日志 What went wrong）'
      }
    }
    if (!file) continue

    matched++
    // 往后最多看 8 行收集 symbol/location 等补充信息；遇到下一条错误行就停
    const detail: string[] = []
    let j = i + 1
    for (let scanned = 0; j < lines.length && scanned < 8; scanned++, j++) {
      if (JAVA_ERROR_RE.test(lines[j]) || GRADLE_SCRIPT_RE.test(lines[j])) break
      const d = DETAIL_RE.exec(lines[j])
      if (d && detail.length < 2) detail.push(`${d[1].toLowerCase()}: ${d[2].trim()}`)
    }
    // 跳过已扫描的尾巴，避免补充行被重复解析
    i = j - 1

    if (errors.length < MAX_ERRORS) {
      errors.push({
        location: col ? `${file}:${lineNo}:${col}` : `${file}:${lineNo}`,
        message: message.trim() || '（该行没有错误消息）',
        ...(detail.length ? { detail: detail.join('；') } : {}),
      })
    }
  }

  // javac 在末尾单独打印「N errors」；有些格式不带，就用匹配到的错误行数
  let explicit = 0
  for (const hit of src.matchAll(TOTAL_RE)) explicit = Math.max(explicit, Number(hit[1]))
  const total = Math.max(matched, explicit)
  if (!total) return { total: 0, errors: [], text: '' }

  const header = `编译错误：共 ${total} 个${errors.length ? `（只显示前 ${errors.length} 条）` : ''}`
  const body = errors.map((e, idx) => {
    const detail = e.detail ? `\n   ${e.detail}` : ''
    return `${idx + 1}) ${clipPath(e.location)}: ${clip(e.message, 200)}${detail}`
  }).join('\n')
  const footer = '先修第 1 条错误再重新 build；源码没改动时连续第 3 次 build 会被直接拒绝，不要盲试。'
  return {
    total,
    errors,
    text: clip([header, body, footer].filter(Boolean).join('\n'), MAX_TEXT),
  }
}
