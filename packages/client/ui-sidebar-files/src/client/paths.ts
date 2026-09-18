/**
 * The tree's path arithmetic.
 *
 * Every path is absolute and joined with `/` whatever the workspace root's own
 * separators are: the Host resolves mixed separators, and the tree only needs a
 * stable key and a stable containment test. Kept apart from the face so the
 * store can prune a removed subtree without importing the face that writes it.
 */

/** The absolute path of one entry's parent-shape without its trailing separators. */
const withoutTrailing = (path: string): string => path.replace(/[/\\]+$/, '')

/**
 * The absolute path of one child entry.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${withoutTrailing(parent)}/${name}`
}

/**
 * Whether one path lies inside a directory's subtree, the directory itself
 * excluded.
 * @param path - the absolute path to test.
 * @param ancestor - the absolute directory path that may contain it.
 * @returns whether `path` is a strict descendant of `ancestor`.
 */
export function isUnder(path: string, ancestor: string): boolean {
  const base = withoutTrailing(ancestor)
  return path !== base && path.startsWith(base === '' ? '/' : `${base}/`)
}
