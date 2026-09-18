/**
 * `sidebarFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the tree could not list, one code each, because a
 * directory that is gone, one outside the workspace, and a path that is not a
 * directory each suggest a different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarFiles'>` or `PropsLocale<'sidebarFiles'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  'entry.other': '这不是文件或目录，没法打开。',
  delete: '删除',
  'delete.title': '删除确认',
  'delete.fileDescription': '永久删除文件 {name}？此操作无法撤销。',
  'delete.dirDescription': '永久删除目录 {name} 及其全部内容？此操作无法撤销。',
  'delete.cancel': '取消',
  'delete.confirm': '永久删除',
  'delete.deleting': '正在删除…',
  'delete.notEmpty': '目录不是空的，没有删除任何内容。',
  'delete.notFound': '这个条目已经不在了，可能已被删除。',
  'delete.outsideWorkspace': '这个条目在工作区之外，侧栏不会删除它。',
  'delete.unavailable': '删除失败：{message}',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no workspace directory.',
  reload: 'Reload',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  delete: 'Delete',
  'delete.title': 'Confirm removal',
  'delete.fileDescription': 'Permanently delete the file {name}? This cannot be undone.',
  'delete.dirDescription': 'Permanently delete the directory {name} and everything inside it? This cannot be undone.',
  'delete.cancel': 'Cancel',
  'delete.confirm': 'Delete permanently',
  'delete.deleting': 'Deleting…',
  'delete.notEmpty': 'The directory is not empty, so nothing was removed.',
  'delete.notFound': 'That entry is gone; it may already have been deleted.',
  'delete.outsideWorkspace': 'That entry is outside the workspace, so the sidebar will not delete it.',
  'delete.unavailable': 'Removal failed: {message}',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
  'error.unavailable': 'Read failed: {message}',
} satisfies Record<SidebarFilesKey, string>
