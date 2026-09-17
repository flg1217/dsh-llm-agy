/**
 * tool-preview 单元测试:AGY 文件类工具结果的 dsh 化补全
 * (读取预览行号格式/截断注记;写编辑的 before/after diff;异常输入静默)。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agyToolFilePath, diffLineSnapshots, enrichAgyToolResult, readFilePreview, readFileRaw, readImageFile,
} from '../src/tool-preview.ts'

describe('tool-preview:文件读取补全', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agy-preview-spec-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('预览带行号;超过 80 行时附总数注记', () => {
    const file = join(dir, 'big.txt')
    writeFileSync(file, Array.from({ length: 120 }, (_, i) => `line-${i + 1}`).join('\n'))
    const preview = readFilePreview(file)
    expect(preview).toBeDefined()
    expect(preview).toContain('  1→line-1')
    expect(preview).toContain(' 80→line-80')
    expect(preview).not.toContain('81→')
    expect(preview).toContain('共 120 行')
  })

  it('小文件完整预览,无截断注记', () => {
    const file = join(dir, 'small.md')
    writeFileSync(file, '# hi\ntext')
    const preview = readFilePreview(file)
    expect(preview).toContain('1→# hi')
    expect(preview).toContain('2→text')
    expect(preview).not.toContain('共')
  })

  it('不存在的文件/非字符串路径返回 undefined', () => {
    expect(readFilePreview(join(dir, 'nope.txt'))).toBeUndefined()
    expect(readFilePreview(undefined)).toBeUndefined()
    expect(readFileRaw(123)).toBeUndefined()
  })
})

describe('tool-preview:图片识别', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agy-preview-img-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('PNG 魔数识别为图片(扩展名缺失也能认)', () => {
    const file = join(dir, 'shot.bin')
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
    const out = readImageFile(file)
    expect(out?.mediaType).toBe('image/png')
    expect(out?.data.byteLength).toBe(11)
  })

  it('文本文件不是图片;缺失/超限返回 undefined', () => {
    const text = join(dir, 'a.txt')
    writeFileSync(text, 'plain text')
    expect(readImageFile(text)).toBeUndefined()
    expect(readImageFile(join(dir, 'nope.png'))).toBeUndefined()
    expect(readImageFile(text, 3)).toBeUndefined() // 3 字节上限 → 超限
  })
})

describe('tool-preview:diff', () => {
  it('中段改动输出 - / + 行与上下文', () => {
    const before = 'a\nb\nc\nd\ne'
    const after = 'a\nb\nC2\nd\ne'
    const diff = diffLineSnapshots(before, after)
    expect(diff).toBeDefined()
    expect(diff).toContain('- 3│c')
    expect(diff).toContain('+ 3│C2')
    expect(diff).toContain('  2│b')
  })

  it('尾部新增行只出 + 行', () => {
    const diff = diffLineSnapshots('a\nb', 'a\nb\nc')
    expect(diff).toContain('+ 3│c')
    expect(diff).not.toContain('- ')
  })

  it('一致/缺失快照返回 undefined', () => {
    expect(diffLineSnapshots('same', 'same')).toBeUndefined()
    expect(diffLineSnapshots(undefined, 'after')).toBeUndefined()
    expect(diffLineSnapshots('before', undefined)).toBeUndefined()
  })
})

describe('tool-preview:路径提取与补全分发', () => {
  it('agyToolFilePath 优先 TargetFile 再 AbsolutePath', () => {
    expect(agyToolFilePath({ TargetFile: 't.md' })).toBe('t.md')
    expect(agyToolFilePath({ AbsolutePath: 'a.md' })).toBe('a.md')
    expect(agyToolFilePath({})).toBeUndefined()
    expect(agyToolFilePath(undefined)).toBeUndefined()
  })

  it('enrichAgyToolResult:view_file 出预览,write/edit 出 diff,其他工具无补全', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-preview-spec2-'))
    try {
      const file = join(dir, 'f.txt')
      writeFileSync(file, 'x\ny\nz')
      expect(enrichAgyToolResult('view_file', file)).toContain('1→x')
      const diff = enrichAgyToolResult('replace_file_content', file, 'x\nY\nz')
      expect(diff).toContain('- 2│Y')
      expect(diff).toContain('+ 2│y')
      expect(enrichAgyToolResult('run_command', file)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
