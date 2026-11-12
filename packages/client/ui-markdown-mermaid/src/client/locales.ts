/** `mermaid` namespace dictionaries for the chat fence layer. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'loading': '正在渲染 Mermaid 图表…',
  'failed': '无法渲染此 Mermaid 图表，已改为显示源码。',
} satisfies Record<string, string>

/** The mermaid namespace key union. */
export type MermaidKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Mermaid fence layer's drawing status copy. */
    mermaid: MermaidKey
  }
}

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'loading': 'Rendering Mermaid diagram…',
  'failed': 'This Mermaid diagram could not be rendered; showing its source instead.',
} satisfies Record<MermaidKey, string>

/** Japanese dictionary, checked against the English keys. */
export const ja = {
  'loading': 'Mermaid 図を描画しています…',
  'failed': 'この Mermaid 図を描画できませんでした。代わりにソースを表示しています。',
} satisfies Record<MermaidKey, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'loading': 'Representando el diagrama de Mermaid…',
  'failed': 'No se pudo representar este diagrama de Mermaid; en su lugar se muestra el código.',
} satisfies Record<MermaidKey, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'loading': 'Rendu du diagramme Mermaid…',
  'failed': 'Impossible de rendre ce diagramme Mermaid ; le code est affiché à la place.',
} satisfies Record<MermaidKey, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'loading': 'Mermaid-Diagramm wird gezeichnet…',
  'failed': 'Dieses Mermaid-Diagramm konnte nicht gezeichnet werden; stattdessen wird der Quelltext angezeigt.',
} satisfies Record<MermaidKey, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'loading': 'Отрисовка диаграммы Mermaid…',
  'failed': 'Не удалось отрисовать эту диаграмму Mermaid; вместо неё показан исходный код.',
} satisfies Record<MermaidKey, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'loading': 'Renderizando o diagrama Mermaid…',
  'failed': 'Não foi possível renderizar este diagrama Mermaid; o código é exibido no lugar.',
} satisfies Record<MermaidKey, string>
