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

/** Japanese mirror. */
export const ja = {
  title: 'プレゼンテーション',
  slide: '{index} 枚目のスライド',
  failed: 'このプレゼンテーションを開けませんでした',
  unsupported: 'プレゼンテーションのプレビューにはファイル全体の内容が必要です',
  edit: '編集',
  stopEdit: '編集を終了',
  save: '保存',
  saving: '保存中…',
  unsaved: '未保存の変更があります',
} satisfies Record<PptxPreviewKey, string>

/** Spanish mirror. */
export const es = {
  title: 'Presentación',
  slide: 'Diapositiva {index}',
  failed: 'No se pudo abrir esta presentación.',
  unsupported: 'La vista previa de la presentación requiere el contenido completo del archivo.',
  edit: 'Editar',
  stopEdit: 'Salir de la edición',
  save: 'Guardar',
  saving: 'Guardando…',
  unsaved: 'Cambios sin guardar',
} satisfies Record<PptxPreviewKey, string>

/** French mirror. */
export const fr = {
  title: 'Présentation',
  slide: 'Diapositive {index}',
  failed: "Impossible d'ouvrir cette présentation.",
  unsupported: "L'aperçu de la présentation nécessite le contenu complet du fichier.",
  edit: 'Modifier',
  stopEdit: "Quitter l'édition",
  save: 'Enregistrer',
  saving: 'Enregistrement…',
  unsaved: 'Modifications non enregistrées',
} satisfies Record<PptxPreviewKey, string>

/** German mirror. */
export const de = {
  title: 'Präsentation',
  slide: 'Folie {index}',
  failed: 'Diese Präsentation konnte nicht geöffnet werden.',
  unsupported: 'Die Präsentationsvorschau benötigt den vollständigen Dateiinhalt.',
  edit: 'Bearbeiten',
  stopEdit: 'Bearbeitung beenden',
  save: 'Speichern',
  saving: 'Wird gespeichert…',
  unsaved: 'Nicht gespeicherte Änderungen',
} satisfies Record<PptxPreviewKey, string>

/** Russian mirror. */
export const ru = {
  title: 'Презентация',
  slide: 'Слайд {index}',
  failed: 'Не удалось открыть эту презентацию.',
  unsupported: 'Для предпросмотра презентации требуется полное содержимое файла.',
  edit: 'Изменить',
  stopEdit: 'Выйти из редактирования',
  save: 'Сохранить',
  saving: 'Сохранение…',
  unsaved: 'Есть несохранённые изменения',
} satisfies Record<PptxPreviewKey, string>

/** Portuguese mirror. */
export const pt = {
  title: 'Apresentação',
  slide: 'Slide {index}',
  failed: 'Não foi possível abrir esta apresentação.',
  unsupported: 'A visualização da apresentação exige o conteúdo completo do arquivo.',
  edit: 'Editar',
  stopEdit: 'Sair da edição',
  save: 'Salvar',
  saving: 'Salvando…',
  unsaved: 'Alterações não salvas',
} satisfies Record<PptxPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** PowerPoint preview selection, controls, and status text. */
    sidebarPptx: PptxPreviewKey
  }
}
