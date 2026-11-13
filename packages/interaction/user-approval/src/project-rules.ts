/**
 * Durable per-project approval rules. One record per project directory holds
 * the rules the user added through the `/allow` command; the approval service
 * appends them after the deployment's configured rules, so a project can
 * narrow or extend what its sessions may do without a restart.
 * @module @deepseek-ai/dsh-user-approval/project-rules
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { ApprovalRule } from './rules.ts'

/** One stored project's ordered rules. */
export interface ProjectApprovalRules {
  readonly rules: readonly ApprovalRule[]
}

const approvalRuleSchema = z.object({
  action: z.string(),
  resource: z.string(),
  effect: z.enum(['allow', 'deny', 'ask']),
})

/**
 * The approval-rules domain: one `projects` table keyed by the exact session
 * working directory recorded when the rule was added.
 */
export const projectApprovalRulesSpec = defineDomain({
  name: 'approval_rules',
  version: 1,
  tables: { projects: domainTable<string, ProjectApprovalRules>(z.object({ rules: z.array(approvalRuleSchema) })) },
})
