/** `btw` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'menu.ask': '就此会话提问',
  title: '侧问',
  description: '问题在会话的已完成历史上下文中回答，不写入主会话。',
  placeholder: '输入问题',
  submit: '提问',
  close: '关闭',
  thinking: '正在回答…',
  failed: '提问失败，请重试。',
  answer: '回答',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type BtwKey = keyof typeof zh

export const en = {
  'menu.ask': 'Ask about this session',
  title: 'Side question',
  description: 'The question is answered with this session’s completed history and adds no turn to the conversation.',
  placeholder: 'Ask a question',
  submit: 'Ask',
  close: 'Close',
  thinking: 'Answering…',
  failed: 'The question failed. Try again.',
  answer: 'Answer',
} satisfies Record<BtwKey, string>

export const ja = {
  'menu.ask': 'このセッションについて質問',
  title: 'サイド質問',
  description: '質問は完了済みの履歴を文脈に回答され、会話には追加されません。',
  placeholder: '質問を入力',
  submit: '質問',
  close: '閉じる',
  thinking: '回答中…',
  failed: '質問に失敗しました。再試行してください。',
  answer: '回答',
} satisfies Record<BtwKey, string>

export const es = {
  'menu.ask': 'Preguntar sobre esta sesión',
  title: 'Pregunta lateral',
  description: 'La pregunta se responde con el historial completado de esta sesión y no añade un turno a la conversación.',
  placeholder: 'Escribe una pregunta',
  submit: 'Preguntar',
  close: 'Cerrar',
  thinking: 'Respondiendo…',
  failed: 'La pregunta falló. Inténtalo de nuevo.',
  answer: 'Respuesta',
} satisfies Record<BtwKey, string>

export const fr = {
  'menu.ask': 'Question sur cette session',
  title: 'Question latérale',
  description: 'La question est traitée avec l’historique terminé de cette session et n’ajoute aucun tour à la conversation.',
  placeholder: 'Poser une question',
  submit: 'Demander',
  close: 'Fermer',
  thinking: 'Réponse en cours…',
  failed: 'La question a échoué. Réessayez.',
  answer: 'Réponse',
} satisfies Record<BtwKey, string>

export const de = {
  'menu.ask': 'Zu dieser Sitzung fragen',
  title: 'Seitenfrage',
  description: 'Die Frage wird mit der abgeschlossenen Historie dieser Sitzung beantwortet und fügt der Unterhaltung keinen Zug hinzu.',
  placeholder: 'Frage eingeben',
  submit: 'Fragen',
  close: 'Schließen',
  thinking: 'Antwort wird erstellt…',
  failed: 'Die Frage ist fehlgeschlagen. Versuchen Sie es erneut.',
  answer: 'Antwort',
} satisfies Record<BtwKey, string>

export const ru = {
  'menu.ask': 'Спросить об этой сессии',
  title: 'Боковой вопрос',
  description: 'Вопрос обрабатывается с завершённой историей этой сессии и не добавляет ход в разговор.',
  placeholder: 'Введите вопрос',
  submit: 'Спросить',
  close: 'Закрыть',
  thinking: 'Ответ готовится…',
  failed: 'Не удалось получить ответ. Повторите попытку.',
  answer: 'Ответ',
} satisfies Record<BtwKey, string>

export const pt = {
  'menu.ask': 'Perguntar sobre esta sessão',
  title: 'Pergunta lateral',
  description: 'A pergunta usa o histórico concluído desta sessão e não adiciona um turno à conversa.',
  placeholder: 'Faça uma pergunta',
  submit: 'Perguntar',
  close: 'Fechar',
  thinking: 'Respondendo…',
  failed: 'A pergunta falhou. Tente novamente.',
  answer: 'Resposta',
} satisfies Record<BtwKey, string>

export const NS = 'btw'
