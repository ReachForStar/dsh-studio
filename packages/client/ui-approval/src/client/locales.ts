/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allow: '允许',
  allowOnce: '允许一次',
  allowAlways: '始终允许',
  fullAccess: '完全访问',
  'fullAccessConfirm.title': '授予完全访问',
  'fullAccessConfirm.description': '本会话将切换为完全访问：不再限制文件修改，也不再询问审批。这次授予只覆盖提交时仍在排队的输入。',
  'fullAccessConfirm.acknowledge': '我已了解风险',
  'fullAccessConfirm.enable': '授予完全访问',
  'fullAccessConfirm.cancel': '取消',
  'fullAccessConfirm.close': '关闭',
  rejectWithCorrection: '修改后拒绝',
  correctionPlaceholder: '写下正确的参数或做法',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allow: 'Allow',
  allowOnce: 'Allow once',
  allowAlways: 'Always allow',
  fullAccess: 'Full access',
  'fullAccessConfirm.title': 'Grant full access',
  'fullAccessConfirm.description': 'This session switches to full access: file changes are no longer restricted and approvals are no longer requested. The grant covers only input queued when you submit it.',
  'fullAccessConfirm.acknowledge': 'I understand the risk',
  'fullAccessConfirm.enable': 'Grant full access',
  'fullAccessConfirm.cancel': 'Cancel',
  'fullAccessConfirm.close': 'Close',
  rejectWithCorrection: 'Reject with correction',
  correctionPlaceholder: 'Corrected arguments or approach',
} satisfies Record<ApprovalKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'waiting': '承認待ち',
  'detail.aria': '承認の詳細',
  'escalation': 'ツール {toolName} が特権実行を要求しています',
  'reject': '拒否',
  'allow': '許可',
  'allowOnce': '1 回だけ許可',
  'allowAlways': '常に許可',
  'fullAccess': 'フルアクセス',
  'fullAccessConfirm.title': 'フルアクセスを許可',
  'fullAccessConfirm.description': 'このセッションはフルアクセスに切り替わります。ファイル変更の制限がなくなり、承認も求められません。許可の対象は送信時点で待機中の入力だけです。',
  'fullAccessConfirm.acknowledge': 'リスクを理解しました',
  'fullAccessConfirm.enable': 'フルアクセスを許可',
  'fullAccessConfirm.cancel': 'キャンセル',
  'fullAccessConfirm.close': '閉じる',
  'rejectWithCorrection': '修正して拒否',
  'correctionPlaceholder': '正しい引数や方法を入力',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  waiting: 'Esperando aprobación',
  'detail.aria': 'Detalles de aprobación',
  escalation: 'La herramienta {toolName} solicita ejecución privilegiada',
  reject: 'Rechazar',
  allow: 'Permitir',
  allowOnce: 'permitir una vez',
  allowAlways: 'Permitir siempre',
  fullAccess: 'Acceso total',
  'fullAccessConfirm.title': 'Conceder acceso total',
  'fullAccessConfirm.description': 'Esta sesión pasa a acceso total: los cambios de archivos ya no se restringen y las aprobaciones dejan de solicitarse. La concesión solo cubre la entrada en cola al enviarla.',
  'fullAccessConfirm.acknowledge': 'Entiendo el riesgo',
  'fullAccessConfirm.enable': 'Conceder acceso total',
  'fullAccessConfirm.cancel': 'Cancelar',
  'fullAccessConfirm.close': 'Cerrar',
  rejectWithCorrection: 'Rechazar con corrección',
  correctionPlaceholder: 'Argumentos o enfoque corregidos',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  waiting: "En attente d'approbation",
  'detail.aria': "Détails de l'approbation",
  escalation: "L'outil {toolName} demande une exécution privilégiée",
  reject: 'Rejeter',
  allow: 'Autoriser',
  allowOnce: 'Autoriser une fois',
  allowAlways: 'Toujours autoriser',
  fullAccess: 'Accès complet',
  'fullAccessConfirm.title': "Accorder l'accès complet",
  'fullAccessConfirm.description': "Cette session passe en accès complet : les modifications de fichiers ne sont plus limitées et aucune approbation n'est plus demandée. L'octroi ne couvre que les entrées en attente au moment de l'envoi.",
  'fullAccessConfirm.acknowledge': 'Je comprends le risque',
  'fullAccessConfirm.enable': "Accorder l'accès complet",
  'fullAccessConfirm.cancel': 'Annuler',
  'fullAccessConfirm.close': 'Fermer',
  rejectWithCorrection: 'Refuser avec correction',
  correctionPlaceholder: 'Arguments ou approche corrigés',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  waiting: 'Warten auf Genehmigung',
  'detail.aria': 'Einzelheiten zur Genehmigung',
  escalation: 'Tool {toolName} fordert privilegierte Ausführung an',
  reject: 'Ablehnen',
  allow: 'Erlauben',
  allowOnce: 'Einmal zulassen',
  allowAlways: 'Immer zulassen',
  fullAccess: 'Voller Zugriff',
  'fullAccessConfirm.title': 'Vollen Zugriff erteilen',
  'fullAccessConfirm.description': 'Diese Sitzung wechselt zu vollem Zugriff: Dateiänderungen werden nicht mehr eingeschränkt und es werden keine Genehmigungen mehr angefragt. Die Erteilung umfasst nur die beim Absenden wartenden Eingaben.',
  'fullAccessConfirm.acknowledge': 'Ich verstehe das Risiko',
  'fullAccessConfirm.enable': 'Vollen Zugriff erteilen',
  'fullAccessConfirm.cancel': 'Abbrechen',
  'fullAccessConfirm.close': 'Schließen',
  rejectWithCorrection: 'Mit Korrektur ablehnen',
  correctionPlaceholder: 'Korrigierte Argumente oder Vorgehensweise',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  waiting: 'Ожидание одобрения',
  'detail.aria': 'Детали утверждения',
  escalation: 'Инструмент {toolName} запрашивает привилегированное выполнение',
  reject: 'Отклонить',
  allow: 'Разрешить',
  allowOnce: 'Разрешить один раз',
  allowAlways: 'Всегда разрешать',
  fullAccess: 'Полный доступ',
  'fullAccessConfirm.title': 'Предоставить полный доступ',
  'fullAccessConfirm.description': 'Сеанс переходит на полный доступ: изменения файлов больше не ограничиваются, запросы утверждения не выдаются. Предоставление охватывает только ввод, ожидавший отправки решения.',
  'fullAccessConfirm.acknowledge': 'Я понимаю риск',
  'fullAccessConfirm.enable': 'Предоставить полный доступ',
  'fullAccessConfirm.cancel': 'Отмена',
  'fullAccessConfirm.close': 'Закрыть',
  rejectWithCorrection: 'Отклонить с исправлением',
  correctionPlaceholder: 'Исправленные аргументы или подход',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  waiting: 'Aguardando aprovação',
  'detail.aria': 'Detalhes de aprovação',
  escalation: 'A ferramenta {toolName} solicita execução privilegiada',
  reject: 'Rejeitar',
  allow: 'Permitir',
  allowOnce: 'Permitir uma vez',
  allowAlways: 'Sempre permitir',
  fullAccess: 'Acesso total',
  'fullAccessConfirm.title': 'Conceder acesso total',
  'fullAccessConfirm.description': 'Esta sessão passa para acesso total: alterações de arquivos deixam de ser restritas e aprovações deixam de ser solicitadas. A concessão cobre apenas a entrada em fila no momento do envio.',
  'fullAccessConfirm.acknowledge': 'Entendo o risco',
  'fullAccessConfirm.enable': 'Conceder acesso total',
  'fullAccessConfirm.cancel': 'Cancelar',
  'fullAccessConfirm.close': 'Fechar',
  rejectWithCorrection: 'Rejeitar com correção',
  correctionPlaceholder: 'Argumentos ou abordagem corrigidos',
} satisfies Record<keyof typeof en, string>
