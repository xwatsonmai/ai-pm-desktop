// Words for the codes the client records (platform tools, run purposes,
// connection errors), shared by the scheduler's messages and the window.

export const TOOL_LABEL: Record<string, string> = {
  task_claim: '认领需求', task_report_work: '汇报进展', task_request_alignment: '发起开发对齐', task_resume_development: '恢复开发',
  task_submit_result: '提交测试', task_mark_deployed: '登记上线', task_rework: '退回开发', task_release: '放弃认领',
  task_close: '关闭需求', task_decline: '拒绝需求', task_get_context: '读取需求', work_list: '读取待办',
  project_get_context: '读取项目', collaboration_claim: '认领协同', collaboration_report: '汇报协同进展',
  collaboration_submit_result: '提交协同结论', collaboration_release: '放弃协同', collaboration_get: '读取协同',
}

export const toolLabel = (tool: string) => TOOL_LABEL[tool] ?? tool

export const PURPOSE_LABEL: Record<string, string> = {
  start: '开始', continue: '继续', repair: '修正格式', resume: '中断后续跑', alignment: '对齐判断',
}

// Connection and run errors arrive as short codes; platform refusals are already sentences.
export function errorText(message: string): string {
  const http = /^(subscription_)?http_(\d+|error)$/.exec(message)
  if (http) return `${http[1] ? '订阅' : '平台'}请求失败（HTTP ${http[2]}）`
  const known: Record<string, string> = {
    login_required: '登录已失效，需要重新登录',
    subscription_closed: '订阅连接断开',
    subscription_not_event_stream: '订阅没有返回事件流',
    subscription_ack_resource_mismatch: '订阅确认的资源与配置不一致',
    read_only_mode: '只读模式下不发写操作',
    'stopped by client': '被客户端停止',
    'process exited without a result': 'Agent 进程退出，没有给出结果',
  }
  if (known[message]) return known[message]
  if (message.startsWith('token_refresh_failed')) return '刷新登录失败' + message.slice('token_refresh_failed'.length).replace(/^:\s*/, '：')
  if (message.startsWith('read_only_mode: ')) return '只读模式下不发写操作：' + toolLabel(message.slice('read_only_mode: '.length))
  return message
}

export const EXECUTOR_LABEL: Record<string, string> = { codex: 'Codex', claude: 'Claude Code', zcode: 'ZCode' }
export const executorLabel = (name: string) => EXECUTOR_LABEL[name] ?? name
