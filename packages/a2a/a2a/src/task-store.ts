import { randomUUID } from 'node:crypto'
import type { A2AArtifact, A2AMessage, A2ATask, A2ATaskStatus, TaskState } from './schema.ts'

/** ISO 8601 UTC with millisecond precision, as the protocol requires. */
function now(): string {
  return new Date().toISOString()
}

/** Retention bounds for one task table. */
export interface TaskStoreOptions {
  /** Tasks kept before the oldest terminal task is evicted. */
  maxTasks?: number
  /** Messages kept per task before the oldest is dropped. */
  maxHistory?: number
}

/** A task as `ListTasks` reports it: artifacts only when the caller asked for them. */
export type A2ATaskRow = Omit<A2ATask, 'artifacts'> & { artifacts?: A2AArtifact[] }

/** The position of one row in `TaskStore.list` order, as a page cursor. */
export interface TaskCursor {
  /** The row's status timestamp. */
  timestamp: string
  /** The row's task id, which also breaks timestamp ties. */
  id: string
}

/** The task table one A2A server works against. */
export class TaskStore {
  private readonly tasks = new Map<string, A2ATask>()
  private readonly byContext = new Map<string, string[]>()
  private readonly maxTasks: number
  private readonly maxHistory: number

  /**
   * @param options - retention bounds; defaults suit a long-running agent.
   */
  constructor(options: TaskStoreOptions = {}) {
    this.maxTasks = options.maxTasks ?? 500
    this.maxHistory = options.maxHistory ?? 20
  }

  /**
   * Read one task.
   * @param id - task identity.
   * @returns the task, or undefined when it is unknown or evicted.
   */
  get(id: string): A2ATask | undefined {
    return this.tasks.get(id)
  }

  /**
   * Record a new task.
   * @param contextId - conversation to attach the task to; a fresh one when absent.
   * @param metadata - peer-defined task metadata.
   * @returns the created task, submitted and empty.
   */
  create(contextId?: string, metadata?: Record<string, unknown>): A2ATask {
    const context = contextId ?? randomUUID()
    const task: A2ATask = {
      id: randomUUID(),
      contextId: context,
      status: { state: 'TASK_STATE_SUBMITTED', timestamp: now() },
      artifacts: [],
      history: [],
      ...metadata === undefined ? {} : { metadata },
    }
    this.tasks.set(task.id, task)
    const siblings = this.byContext.get(context) ?? []
    siblings.push(task.id)
    this.byContext.set(context, siblings)
    this.evict()
    return task
  }

  /**
   * Read tasks, most recently updated first, without artifact content unless asked.
   * @param filter - optional conversation and state filter.
   * @param pageSize - rows to return; values under 1 read one row.
   * @param includeArtifacts - whether to keep artifact content in the rows.
   * @param after - cursor reading the page after the row it names; a row the
   *   table no longer holds ends pagination with an empty page.
   * @returns the selected rows, newest status timestamp first.
   */
  list(
    filter: { contextId?: string; status?: TaskState } = {},
    pageSize: number = 50,
    includeArtifacts: boolean = false,
    after: TaskCursor | undefined = undefined,
  ): A2ATaskRow[] {
    const rows = this.selected(filter)
    let start = 0
    if (after !== undefined) {
      const index = rows.findIndex(task => task.id === after.id && task.status.timestamp === after.timestamp)
      if (index < 0) return []
      start = index + 1
    }
    return rows.slice(start, start + Math.max(pageSize, 1))
      .map((task) => {
        if (includeArtifacts) return task
        const { artifacts: _artifacts, ...rest } = task
        return rest as A2ATaskRow
      })
  }

  /**
   * Count the tasks a filter selects, for `ListTasks` totals.
   * @param filter - optional conversation and state filter.
   * @returns how many tasks the filter selects.
   */
  count(filter: { contextId?: string; status?: TaskState } = {}): number {
    return this.selected(filter).length
  }

  /**
   * Every stored task, most recently updated first.
   * @returns every stored task, by descending status timestamp.
   */
  all(): A2ATask[] {
    return this.selected({})
  }

  /**
   * Append one message to a task's history, dropping the oldest beyond the bound.
   * @param task - the task to append to.
   * @param message - the message to record.
   */
  pushHistory(task: A2ATask, message: A2AMessage): void {
    task.history.push(message)
    if (task.history.length > this.maxHistory) {
      task.history.splice(0, task.history.length - this.maxHistory)
    }
  }

  /**
   * Replace a task's status, optionally attaching a status message.
   * @param task - the task to update.
   * @param state - the new state.
   * @param text - status message text; absent leaves the status message unset.
   */
  setStatus(task: A2ATask, state: TaskState, text?: string): void {
    const status: A2ATaskStatus = { state, timestamp: now() }
    if (text !== undefined && text.length > 0) {
      status.message = {
        messageId: randomUUID(),
        contextId: task.contextId,
        taskId: task.id,
        role: 'ROLE_AGENT',
        parts: [{ text }],
      }
    }
    task.status = status
  }

  /**
   * Append text to an artifact, creating it on first write.
   * @param task - the task the artifact belongs to.
   * @param artifactId - artifact identity, stable across updates.
   * @param name - artifact name, used when the artifact is created.
   * @param text - text to append.
   */
  appendArtifact(task: A2ATask, artifactId: string, name: string, text: string): void {
    let artifact: A2AArtifact | undefined = task.artifacts.find(item => item.artifactId === artifactId)
    if (artifact === undefined) {
      artifact = { artifactId, name, parts: [] }
      task.artifacts.push(artifact)
    }
    const last = artifact.parts[artifact.parts.length - 1]
    if (last !== undefined && last.text !== undefined) last.text += text
    else artifact.parts.push({ text })
  }

  /** Tasks matching a filter, by descending status timestamp with id breaking ties. */
  private selected(filter: { contextId?: string; status?: TaskState }): A2ATask[] {
    let rows = [...this.tasks.values()]
    if (filter.contextId !== undefined) rows = rows.filter(task => task.contextId === filter.contextId)
    if (filter.status !== undefined) rows = rows.filter(task => task.status.state === filter.status)
    // ISO 8601 UTC strings compare chronologically as plain strings.
    return rows.sort((a, b) =>
      a.status.timestamp === b.status.timestamp
        ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        : (a.status.timestamp < b.status.timestamp ? 1 : -1))
  }

  /** Drop the oldest terminal tasks once the table is over its bound. */
  private evict(): void {
    if (this.tasks.size <= this.maxTasks) return
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= this.maxTasks) break
      if (!isTerminalState(task.status.state)) continue
      this.tasks.delete(id)
      const siblings = this.byContext.get(task.contextId)
      if (siblings === undefined) continue
      const index = siblings.indexOf(id)
      if (index >= 0) siblings.splice(index, 1)
      if (siblings.length === 0) this.byContext.delete(task.contextId)
    }
  }
}

/** Whether a state ends the task; kept local so the store owns no schema helper. */
function isTerminalState(state: TaskState): boolean {
  return state === 'TASK_STATE_COMPLETED'
    || state === 'TASK_STATE_FAILED'
    || state === 'TASK_STATE_CANCELED'
    || state === 'TASK_STATE_REJECTED'
}
