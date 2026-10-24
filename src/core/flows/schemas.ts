// Output schemas, one per kind of run. They follow the strict structured-output
// rules (every property required, no extra properties), so the same object is
// passed to the CLI and used for validation.

const str = { type: 'string' }

function object(properties: Record<string, object>) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) }
}

const question = object({ title: str, detail: str })

export const schemas = {
  plan: object({
    summary: str,
    plan: str,
    tests: str,
    risks: str,
    business_questions: {
      type: 'array',
      items: object({
        id: str,
        title: str,
        description: str,
        kind: { type: 'string', enum: ['single_choice', 'multiple_choice', 'text'] },
        required: { type: 'boolean' },
        options: { type: 'array', items: object({ id: str, label: str, impact: str }) },
        recommended_option_ids: { type: 'array', items: str },
      }),
    },
    technical_findings: { type: 'array', items: object({ topic: str, conclusion: str, evidence: str }) },
  }),
  develop: object({
    status: { type: 'string', enum: ['done', 'needs_alignment', 'needs_user', 'blocked'] },
    summary: str,
    sha: str,
    tests: str,
    limitations: str,
    message: str,
    alignment_questions: { type: 'array', items: question },
  }),
  alignment: object({
    decision: { type: 'string', enum: ['resume', 'ask_again'] },
    body: str,
    questions: { type: 'array', items: question },
  }),
  release: object({
    outcome: { type: 'string', enum: ['success', 'partial', 'failed'] },
    deployed_sha: str,
    environment: str,
    summary: str,
    verification: str,
    limitations: str,
    items: { type: 'array', items: object({ task_id: str, included_sha: str, ok: { type: 'boolean' } }) },
  }),
  collab: object({
    outcome: str,
    summary: str,
    environment: str,
    observed_at: str,
    deployment_version: str,
    limitations: str,
    evidence: str,
  }),
} as const

export type SchemaName = keyof typeof schemas
