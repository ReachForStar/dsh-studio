/** Locale-owned video renderer labels and status text. */
export const zh = {
  title: '视频',
  preview: '视频预览：{name}',
  loading: '正在读取…',
  failed: '无法播放这段视频',
  unsupported: '视频预览需要完整文件内容',
} satisfies Record<string, string>

/** Video renderer dictionary keys. */
export type VideoPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Video',
  preview: 'Video preview: {name}',
  loading: 'Reading…',
  failed: 'This video could not be played.',
  unsupported: 'Video preview requires the complete file contents.',
} satisfies Record<VideoPreviewKey, string>

/** Japanese mirror. */
export const ja = {
  title: '動画',
  preview: '動画プレビュー：{name}',
  loading: '読み込み中…',
  failed: 'この動画を再生できませんでした',
  unsupported: '動画プレビューにはファイル全体の内容が必要です',
} satisfies Record<VideoPreviewKey, string>

/** Spanish mirror. */
export const es = {
  title: 'Vídeo',
  preview: 'Vista previa del vídeo: {name}',
  loading: 'Leyendo…',
  failed: 'No se pudo reproducir este vídeo.',
  unsupported: 'La vista previa del vídeo requiere el contenido completo del archivo.',
} satisfies Record<VideoPreviewKey, string>

/** French mirror. */
export const fr = {
  title: 'Vidéo',
  preview: 'Aperçu vidéo : {name}',
  loading: 'Lecture…',
  failed: 'Impossible de lire cette vidéo.',
  unsupported: "L'aperçu vidéo nécessite le contenu complet du fichier.",
} satisfies Record<VideoPreviewKey, string>

/** German mirror. */
export const de = {
  title: 'Video',
  preview: 'Videovorschau: {name}',
  loading: 'Wird gelesen…',
  failed: 'Dieses Video konnte nicht wiedergegeben werden.',
  unsupported: 'Die Videovorschau benötigt den vollständigen Dateiinhalt.',
} satisfies Record<VideoPreviewKey, string>

/** Russian mirror. */
export const ru = {
  title: 'Видео',
  preview: 'Предпросмотр видео: {name}',
  loading: 'Чтение…',
  failed: 'Не удалось воспроизвести это видео.',
  unsupported: 'Для предпросмотра видео требуется полное содержимое файла.',
} satisfies Record<VideoPreviewKey, string>

/** Portuguese mirror. */
export const pt = {
  title: 'Vídeo',
  preview: 'Prévia do vídeo: {name}',
  loading: 'Lendo…',
  failed: 'Não foi possível reproduzir este vídeo.',
  unsupported: 'A visualização do vídeo exige o conteúdo completo do arquivo.',
} satisfies Record<VideoPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Video preview selection, accessible name, and status text. */
    sidebarVideo: VideoPreviewKey
  }
}
