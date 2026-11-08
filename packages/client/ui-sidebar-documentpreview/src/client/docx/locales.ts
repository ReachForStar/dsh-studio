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

/** Japanese mirror. */
export const ja = {
  title: 'Word 文書',
  paragraph: '{index} 段落目',
  failed: 'この Word 文書を開けませんでした',
  unsupported: 'Word プレビューにはファイル全体の内容が必要です',
  edit: '編集',
  stopEdit: '編集を終了',
  save: '保存',
  saving: '保存中…',
  unsaved: '未保存の変更があります',
} satisfies Record<DocxPreviewKey, string>

/** Spanish mirror. */
export const es = {
  title: 'Documento de Word',
  paragraph: 'Párrafo {index}',
  failed: 'No se pudo abrir este documento de Word.',
  unsupported: 'La vista previa de Word requiere el contenido completo del archivo.',
  edit: 'Editar',
  stopEdit: 'Salir de la edición',
  save: 'Guardar',
  saving: 'Guardando…',
  unsaved: 'Cambios sin guardar',
} satisfies Record<DocxPreviewKey, string>

/** French mirror. */
export const fr = {
  title: 'Document Word',
  paragraph: 'Paragraphe {index}',
  failed: "Impossible d'ouvrir ce document Word.",
  unsupported: "L'aperçu Word nécessite le contenu complet du fichier.",
  edit: 'Modifier',
  stopEdit: "Quitter l'édition",
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  unsaved: 'Modifications non enregistrées',
} satisfies Record<DocxPreviewKey, string>

/** German mirror. */
export const de = {
  title: 'Word-Dokument',
  paragraph: 'Absatz {index}',
  failed: 'Dieses Word-Dokument konnte nicht geöffnet werden.',
  unsupported: 'Die Word-Vorschau benötigt den vollständigen Dateiinhalt.',
  edit: 'Bearbeiten',
  stopEdit: 'Bearbeitung beenden',
  save: 'Speichern',
  saving: 'Wird gespeichert…',
  unsaved: 'Nicht gespeicherte Änderungen',
} satisfies Record<DocxPreviewKey, string>

/** Russian mirror. */
export const ru = {
  title: 'Документ Word',
  paragraph: 'Абзац {index}',
  failed: 'Не удалось открыть этот документ Word.',
  unsupported: 'Для предпросмотра Word требуется полное содержимое файла.',
  edit: 'Изменить',
  stopEdit: 'Выйти из редактирования',
  save: 'Сохранить',
  saving: 'Сохранение…',
  unsaved: 'Есть несохранённые изменения',
} satisfies Record<DocxPreviewKey, string>

/** Portuguese mirror. */
export const pt = {
  title: 'Documento do Word',
  paragraph: 'Parágrafo {index}',
  failed: 'Não foi possível abrir este documento do Word.',
  unsupported: 'A visualização do Word exige o conteúdo completo do arquivo.',
  edit: 'Editar',
  stopEdit: 'Sair da edição',
  save: 'Salvar',
  saving: 'Salvando…',
  unsaved: 'Alterações não salvas',
} satisfies Record<DocxPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Word preview selection, controls, and status text. */
    sidebarDocx: DocxPreviewKey
  }
}
