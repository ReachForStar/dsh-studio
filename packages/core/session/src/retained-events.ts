/**
 * Declarations retained only so sessions written by released builds stay readable.
 *
 * These six event types lost their producers when the fork removed the
 * capabilities it adopted from qwen-code, pi, opencode, and codex. The members
 * stay declared because the reader refuses unknown types unless the record
 * carries `ignorable`, so dropping them would make existing logs unsafe to
 * read. Each was log-only, so no projection in this build folds it.
 *
 * @module @deepseek-ai/dsh-session/retained-events
 */

import type { ContextFormed } from '@deepseek-ai/dsh-llm'

/** What became of one predicted tool call. */
export type SpeculationStepStatus = 'read' | 'overlay-write' | 'failed' | 'boundary'

/** One predicted tool call and its outcome. */
export interface SpeculationStepRecord {
  /** Tool name the prediction asked for. */
  tool: string
  /** Whether the call ran unchanged, wrote into the overlay, failed, or stopped the plan. */
  status: SpeculationStepStatus
}

/** Log-only record of one completed prediction. */
export interface SpeculationProposalEventData {
  /** Turn whose completion produced the prediction. */
  turn: number
  /** Predicted next request text, as the model returned it. */
  predictedRequest: string
  /** Predicted calls in model order, ending at the boundary that stopped the plan. */
  steps: SpeculationStepRecord[]
}

/** Log-only record of how a prediction ended. */
export interface SpeculationOutcomeEventData {
  /** Turn whose prediction was settled. */
  turn: number
  /** Whether the prediction was accepted into the workspace or dropped. */
  decision: 'commit' | 'discard'
  /** Workspace paths the commit wrote, or overlay paths the discard removed. */
  paths: string[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Latest-wins next-step suggestions for one completed turn. It is log-only
     * presentation data: it never enters the model surface or derived history.
     */
    'followup/suggestions': {
      /** Turn whose completion produced the suggestions. */
      turn: number
      /** Concrete next actions the user can pick, in suggested order. */
      suggestions: string[]
    }
    /**
     * 给一个会话条目打标签或清除标签。log-only：不进入模型可见表面。
     * `label` 为 null 时清除该条目的标签。
     */
    'session/label': {
      /** 目标条目的会话序号。 */
      target: SessionSeq
      /** 标签文本；null 表示清除。 */
      label: string | null
    }
    /**
     * Latest-wins prediction for one completed turn. It is log-only
     * presentation data: it never enters the model surface or derived history.
     */
    'speculation/proposal': SpeculationProposalEventData
    /** Log-only settlement of one prediction; it never enters the model surface. */
    'speculation/outcome': SpeculationOutcomeEventData
    /**
     * Latest-wins one-line summary of one completed step's tool batch. It is
     * log-only presentation data: it never enters the model surface or derived
     * history.
     */
    'tool/batch-summary': {
      /** Turn whose step batch is summarized. */
      turn: number
      /** Step whose tool batch is summarized. */
      step: number
      /** One-line summary text supplied by the auxiliary model. */
      summary: string
      /** Tool calls in the summarized batch. */
      callCount: number
    }
    /**
     * 虚拟模型路由状态。log-only：不进入模型可见表面。
     * 每条记录一个虚拟模型的当前状态。
     */
    'virtual-model/state': {
      /** 虚拟模型 provider。 */
      provider: string
      /** 虚拟模型 id。 */
      modelId: string
      /** 路由器保存的 JSON 状态。 */
      state: unknown
    }
  }
}
/**
 * Message attributions retained for the same reason as the events above.
 * Consumers fall through unknown kinds, so these declarations keep the durable
 * vocabulary complete instead of changing the meaning of stored messages.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Comparison prompt one Arena contender receives. */
    'dsh-arena': { kind: 'dsh-arena' } & ContextFormed
    /** Auxiliary next-request prediction requests this package issues. */
    'dsh-speculation': { kind: 'dsh-speculation' } & ContextFormed
    /** Auxiliary next-step suggestion requests this package issues. */
    'followup': { kind: 'followup' } & ContextFormed
    /** Auxiliary tool-batch summarization requests this package issues. */
    'tool-summary': { kind: 'tool-summary' } & ContextFormed
    /** 本包为生成新会话提示词草稿发起的辅助请求。 */
    'handoff': { kind: 'handoff' }
    /**
     * Persistent memory notes this package maintains on the user's behalf.
     * Readers preserve the message without the producer.
     * @persistenceAttribution
     */
    'memory-notes': { kind: 'memory-notes' }
    /** 提示模板展开后注入的用户消息。 */
    'prompt-template': { kind: 'prompt-template'; template: string }
    /** Prompt-cache keep-alive requests this package issues. */
    'warming': { kind: 'warming' } & ContextFormed
    /** Loop-issued ownership notice on a forked Session's first step. */
    'fork-notice': { kind: 'fork-notice' }
  }
}
