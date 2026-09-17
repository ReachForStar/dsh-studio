/** Locale-owned Word renderer labels, controls, and status text. */
export const zh = {
  title: 'Word 文档',
  paragraph: '第 {index} 段',
  failed: '无法打开这个 Word 文档',
  unsupported: 'Word 预览需要完整文件内容',
  edit: '编辑',
  stopEdit: '退出编辑',
  save: '保存',
  saving: '保存中…',
  unsaved: '有未保存的修改',
} satisfies Record<string, string>

/** Word renderer dictionary keys. */
export type DocxPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Word document',
  paragraph: 'Paragraph {index}',
  failed: 'This Word document could not be opened.',
  unsupported: 'Word preview requires the complete file contents.',
  edit: 'Edit',
  stopEdit: 'Stop editing',
  save: 'Save',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
} satisfies Record<DocxPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Word preview selection, controls, and status text. */
    sidebarDocx: DocxPreviewKey
  }
}
