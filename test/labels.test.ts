import { describe, expect, it } from 'vitest'
import { eventText } from '../src/renderer/model.js'
import { errorText, toolLabel } from '../src/shared/labels.js'

describe('codes shown in the window', () => {
  it('names platform operations, runs and sync failures in words', () => {
    expect(eventText({ type: 'platform_ok', message: 'task_report_work' })).toBe('汇报进展')
    expect(eventText({ type: 'run_started', message: 'develop · start' })).toBe('开发 · 开始')
    expect(eventText({ type: 'run_started', message: 'plan · continue' })).toBe('方案 · 继续')
    expect(eventText({ type: 'platform_retry', message: 'task_claim: http_502' })).toBe('认领需求：平台请求失败（HTTP 502）')
    expect(eventText({ type: 'platform_rejected', message: 'task_submit_result: 记录已变化，请刷新后重试' })).toBe('提交测试：记录已变化，请刷新后重试')
    expect(eventText({ type: 'needs_you', message: 'plan_confirm: 方案摘要' })).toBe('方案待确认：方案摘要')
    expect(eventText({ type: 'reconcile_failed', message: 'startup: MCP error -32001: Request timed out' })).toBe('启动时同步失败：MCP error -32001: Request timed out')
    expect(eventText({ type: 'batch_created', message: 'task:a, task:b' })).toBe('2 个需求')
    expect(eventText({ type: 'claiming', message: '模板设置价格' })).toBe('模板设置价格')
  })

  it('keeps sentences and unknown codes as they are', () => {
    expect(errorText('login_required')).toBe('登录已失效，需要重新登录')
    expect(errorText('subscription_http_503')).toBe('订阅请求失败（HTTP 503）')
    expect(errorText('token_refresh_failed: fetch failed')).toBe('刷新登录失败：fetch failed')
    expect(errorText('请填写实现说明')).toBe('请填写实现说明')
    expect(toolLabel('some_new_tool')).toBe('some_new_tool')
  })
})
