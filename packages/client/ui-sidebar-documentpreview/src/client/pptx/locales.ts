/** Locale-owned PowerPoint renderer labels, controls, and status text. */
export const zh = {
  title: '演示文稿',
  slide: '幻灯片 {index}',
  failed: '无法打开这份演示文稿',
  unsupported: '演示文稿预览需要完整文件内容',
  edit: '编辑',
  stopEdit: '退出编辑',
  save: '保存',
  saving: '保存中…',
  unsaved: '有未保存的修改',
} satisfies Record<string, string>

/** PowerPoint renderer dictionary keys. */
export type PptxPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Presentation',
  slide: 'Slide {index}',
  failed: 'This presentation could not be opened.',
  unsupported: 'Presentation preview requires the complete file contents.',
  edit: 'Edit',
  stopEdit: 'Stop editing',
  save: 'Save',
  saving: 'Saving…',
  unsaved: 'Unsaved changes',
} satisfies Record<PptxPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PowerPoint preview selection, controls, and status text. */
    sidebarPptx: PptxPreviewKey
  }
}
