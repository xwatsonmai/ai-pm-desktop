import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { requirementOf } from '../src/main/controller.js'
import type { Task } from '../src/core/types.js'
import { Markdown } from '../src/renderer/components/Markdown.js'

describe('requirement shown next to the plan', () => {
  it('renders the requirement text without letting it inject markup', () => {
    const html = renderToStaticMarkup(<Markdown text={[
      '# 模板价格配置', '', '## 目标', '① 批量调价 **一次性覆盖**', '', '1. 第一条', '2. 第二条 `code`',
      '- 列表项 [文档](https://example.com/a)', '<img src=x onerror="alert(1)">', '[坏链接](javascript:alert(1))',
    ].join('\n')} />)
    expect(html).toContain('<h2 class="md-heading">模板价格配置</h2>')
    expect(html).toContain('<strong>一次性覆盖</strong>')
    expect(html).toContain('<ol class="md-list"><li>第一条</li><li>第二条 <code>code</code></li></ol>')
    expect(html).toContain('<a href="https://example.com/a" target="_blank" rel="noreferrer">文档</a>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).not.toContain('href="javascript')
  })

  it('takes the confirmed text, criteria and review conclusions from the platform context', () => {
    const task = {
      kind: 'task', title: '模板设置价格',
      data: { context: {
        task: { title: '模板设置价格', kind: 'requirement', revision: 2, description: '# 新版', acceptance: ['条件一', '条件二'] },
        requirement_review: {
          agenda: [{ title: '调价是一次性还是长期规则', conclusion: '一次性批量覆盖' }, { title: '未定', status: 'open' }],
          source: { description: '产品最初的写法' },
        },
      } },
    } as unknown as Task
    expect(requirementOf(task)).toEqual({
      title: '模板设置价格', kind: 'requirement', revision: 2, description: '# 新版', acceptance: ['条件一', '条件二'],
      decisions: [{ title: '调价是一次性还是长期规则', conclusion: '一次性批量覆盖' }], original: '产品最初的写法', parent: null,
    })
    expect(requirementOf({ ...task, kind: 'batch' } as Task)).toBeNull()
  })
})
