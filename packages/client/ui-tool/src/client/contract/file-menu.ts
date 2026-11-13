/** File-menu inject face declared by the Tool contract. */
/** File paths are resolved when a gesture begins, not when the Slot is mounted. */
export interface ToolFileInjected {
  /** Resolve an argument from the live Session directory. @param path - Recorded path. @returns Host path. */
  resolveFilePath: (path: string) => string
}
