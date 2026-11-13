/** MCP settings tab copy. */
export type McpSettingsLocaleKey =
  | 'tab'
  | 'description'
  | 'empty'
  | 'unavailable'
  | 'failedToLoad'
  | 'statusConnected'
  | 'statusConnecting'
  | 'statusReconnecting'
  | 'statusWaitingCredentials'
  | 'statusWaitingAuthorization'
  | 'statusFailed'
  | 'statusDisabled'
  | 'statusClosed'
  | 'reasonGaveUp'
  | 'reasonReconnectDisabled'
  | 'reasonUnclosedGeneration'
  | 'reasonLoad'
  | 'reasonCleanup'
  | 'authorize'
  | 'clearAuthorization'
  | 'restart'
  | 'working'
  | 'actionFailed'
  | 'lastError'

/** English copy. */
export const en: Record<McpSettingsLocaleKey, string> = {
  tab: 'MCP servers',
  description: 'Connection state of the MCP servers this Host manages. Authorization opens in a browser tab and applies to every session that uses the server.',
  empty: 'No MCP servers are configured. Add one under Settings → Plugins, or install a plugin that registers one.',
  unavailable: 'The MCP server manager is not reachable from this client.',
  failedToLoad: 'The server list could not be read.',
  statusConnected: 'Connected · {count} tools',
  statusConnecting: 'Connecting',
  statusReconnecting: 'Reconnecting · attempt {attempt}/{max}',
  statusWaitingCredentials: 'Waiting for credentials',
  statusWaitingAuthorization: 'Waiting for authorization',
  statusFailed: 'Failed · {reason}',
  statusDisabled: 'Disabled',
  statusClosed: 'Closed',
  reasonGaveUp: 'reconnect attempts exhausted',
  reasonReconnectDisabled: 'reconnect disabled',
  reasonUnclosedGeneration: 'previous connection did not close',
  reasonLoad: 'the plugin could not load',
  reasonCleanup: 'cleanup is incomplete',
  authorize: 'Authorize',
  clearAuthorization: 'Clear authorization',
  restart: 'Restart',
  working: 'Working…',
  actionFailed: 'The action failed: {message}',
  lastError: 'Last error',
}

/** Simplified Chinese copy. */
export const zh: Record<McpSettingsLocaleKey, string> = {
  tab: 'MCP 服务器',
  description: '本宿主管理的 MCP 服务器连接状态。授权会在浏览器标签页中打开，并对使用该服务器的所有会话生效。',
  empty: '尚未配置 MCP 服务器。可在「设置 → 插件」中添加，或安装会注册服务器的插件。',
  unavailable: '当前客户端无法连接 MCP 服务器管理器。',
  failedToLoad: '无法读取服务器列表。',
  statusConnected: '已连接 · {count} 个工具',
  statusConnecting: '连接中',
  statusReconnecting: '重连中 · 第 {attempt}/{max} 次',
  statusWaitingCredentials: '等待凭据',
  statusWaitingAuthorization: '等待授权',
  statusFailed: '失败 · {reason}',
  statusDisabled: '已停用',
  statusClosed: '已关闭',
  reasonGaveUp: '重连次数耗尽',
  reasonReconnectDisabled: '重连已禁用',
  reasonUnclosedGeneration: '上一个连接未关闭',
  reasonLoad: '插件加载失败',
  reasonCleanup: '清理未完成',
  authorize: '授权',
  clearAuthorization: '清除授权',
  restart: '重启',
  working: '处理中…',
  actionFailed: '操作失败：{message}',
  lastError: '最近错误',
}

/** Japanese copy. */
export const ja: Record<McpSettingsLocaleKey, string> = {
  tab: 'MCP サーバー',
  description: 'このホストが管理する MCP サーバーの接続状態です。認可はブラウザーのタブで開き、そのサーバーを使うすべてのセッションに適用されます。',
  empty: 'MCP サーバーが設定されていません。「設定 → プラグイン」で追加するか、サーバーを登録するプラグインを導入してください。',
  unavailable: 'このクライアントから MCP サーバーマネージャーに接続できません。',
  failedToLoad: 'サーバー一覧を読み取れませんでした。',
  statusConnected: '接続済み · ツール {count} 件',
  statusConnecting: '接続中',
  statusReconnecting: '再接続中 · {attempt}/{max} 回目',
  statusWaitingCredentials: '認証情報を待機中',
  statusWaitingAuthorization: '認可を待機中',
  statusFailed: '失敗 · {reason}',
  statusDisabled: '無効',
  statusClosed: '閉じました',
  reasonGaveUp: '再接続回数の上限に達しました',
  reasonReconnectDisabled: '再接続は無効です',
  reasonUnclosedGeneration: '前の接続が閉じていません',
  reasonLoad: 'プラグインを読み込めませんでした',
  reasonCleanup: 'クリーンアップが完了していません',
  authorize: '認可',
  clearAuthorization: '認可を削除',
  restart: '再起動',
  working: '処理中…',
  actionFailed: '操作に失敗しました: {message}',
  lastError: '最新のエラー',
}

/** Spanish copy. */
export const es: Record<McpSettingsLocaleKey, string> = {
  tab: 'Servidores MCP',
  description: 'Estado de conexión de los servidores MCP que gestiona este Host. La autorización se abre en una pestaña del navegador y se aplica a todas las sesiones que usan el servidor.',
  empty: 'No hay servidores MCP configurados. Añade uno en «Ajustes → Complementos» o instala un complemento que registre uno.',
  unavailable: 'Este cliente no puede acceder al gestor de servidores MCP.',
  failedToLoad: 'No se pudo leer la lista de servidores.',
  statusConnected: 'Conectado · {count} herramientas',
  statusConnecting: 'Conectando',
  statusReconnecting: 'Reconectando · intento {attempt}/{max}',
  statusWaitingCredentials: 'Esperando credenciales',
  statusWaitingAuthorization: 'Esperando autorización',
  statusFailed: 'Error · {reason}',
  statusDisabled: 'Desactivado',
  statusClosed: 'Cerrado',
  reasonGaveUp: 'intentos de reconexión agotados',
  reasonReconnectDisabled: 'reconexión desactivada',
  reasonUnclosedGeneration: 'la conexión anterior no se cerró',
  reasonLoad: 'el complemento no se pudo cargar',
  reasonCleanup: 'la limpieza está incompleta',
  authorize: 'Autorizar',
  clearAuthorization: 'Borrar autorización',
  restart: 'Reiniciar',
  working: 'Procesando…',
  actionFailed: 'La acción falló: {message}',
  lastError: 'Último error',
}

/** French copy. */
export const fr: Record<McpSettingsLocaleKey, string> = {
  tab: 'Serveurs MCP',
  description: 'État de connexion des serveurs MCP gérés par cet hôte. L’autorisation s’ouvre dans un onglet du navigateur et s’applique à toutes les sessions qui utilisent le serveur.',
  empty: 'Aucun serveur MCP n’est configuré. Ajoutez-en un dans « Réglages → Extensions » ou installez une extension qui en enregistre un.',
  unavailable: 'Ce client ne peut pas joindre le gestionnaire de serveurs MCP.',
  failedToLoad: 'La liste des serveurs n’a pas pu être lue.',
  statusConnected: 'Connecté · {count} outils',
  statusConnecting: 'Connexion',
  statusReconnecting: 'Reconnexion · tentative {attempt}/{max}',
  statusWaitingCredentials: 'En attente des identifiants',
  statusWaitingAuthorization: 'En attente d’autorisation',
  statusFailed: 'Échec · {reason}',
  statusDisabled: 'Désactivé',
  statusClosed: 'Fermé',
  reasonGaveUp: 'tentatives de reconnexion épuisées',
  reasonReconnectDisabled: 'reconnexion désactivée',
  reasonUnclosedGeneration: 'la connexion précédente ne s’est pas fermée',
  reasonLoad: 'l’extension n’a pas pu se charger',
  reasonCleanup: 'le nettoyage est incomplet',
  authorize: 'Autoriser',
  clearAuthorization: 'Effacer l’autorisation',
  restart: 'Redémarrer',
  working: 'En cours…',
  actionFailed: 'L’action a échoué : {message}',
  lastError: 'Dernière erreur',
}

/** German copy. */
export const de: Record<McpSettingsLocaleKey, string> = {
  tab: 'MCP-Server',
  description: 'Verbindungsstatus der von diesem Host verwalteten MCP-Server. Die Autorisierung öffnet sich in einem Browser-Tab und gilt für alle Sitzungen, die den Server nutzen.',
  empty: 'Es sind keine MCP-Server konfiguriert. Füge unter „Einstellungen → Plugins“ einen hinzu oder installiere ein Plugin, das einen registriert.',
  unavailable: 'Der MCP-Server-Manager ist von diesem Client aus nicht erreichbar.',
  failedToLoad: 'Die Serverliste konnte nicht gelesen werden.',
  statusConnected: 'Verbunden · {count} Werkzeuge',
  statusConnecting: 'Verbindung wird aufgebaut',
  statusReconnecting: 'Neuverbindung · Versuch {attempt}/{max}',
  statusWaitingCredentials: 'Warte auf Anmeldedaten',
  statusWaitingAuthorization: 'Warte auf Autorisierung',
  statusFailed: 'Fehlgeschlagen · {reason}',
  statusDisabled: 'Deaktiviert',
  statusClosed: 'Geschlossen',
  reasonGaveUp: 'Neuversuche erschöpft',
  reasonReconnectDisabled: 'Neuverbindung deaktiviert',
  reasonUnclosedGeneration: 'vorherige Verbindung wurde nicht geschlossen',
  reasonLoad: 'das Plugin konnte nicht geladen werden',
  reasonCleanup: 'Aufräumen ist unvollständig',
  authorize: 'Autorisieren',
  clearAuthorization: 'Autorisierung löschen',
  restart: 'Neu starten',
  working: 'Wird ausgeführt…',
  actionFailed: 'Die Aktion ist fehlgeschlagen: {message}',
  lastError: 'Letzter Fehler',
}

/** Russian copy. */
export const ru: Record<McpSettingsLocaleKey, string> = {
  tab: 'Серверы MCP',
  description: 'Состояние подключения серверов MCP, которыми управляет этот хост. Авторизация открывается во вкладке браузера и действует для всех сеансов, использующих сервер.',
  empty: 'Серверы MCP не настроены. Добавьте сервер в разделе «Настройки → Плагины» или установите плагин, который его регистрирует.',
  unavailable: 'Этот клиент не может связаться с менеджером серверов MCP.',
  failedToLoad: 'Не удалось прочитать список серверов.',
  statusConnected: 'Подключено · инструментов: {count}',
  statusConnecting: 'Подключение',
  statusReconnecting: 'Переподключение · попытка {attempt}/{max}',
  statusWaitingCredentials: 'Ожидание учётных данных',
  statusWaitingAuthorization: 'Ожидание авторизации',
  statusFailed: 'Ошибка · {reason}',
  statusDisabled: 'Отключено',
  statusClosed: 'Закрыто',
  reasonGaveUp: 'попытки переподключения исчерпаны',
  reasonReconnectDisabled: 'переподключение отключено',
  reasonUnclosedGeneration: 'предыдущее соединение не закрылось',
  reasonLoad: 'плагин не загрузился',
  reasonCleanup: 'очистка не завершена',
  authorize: 'Авторизовать',
  clearAuthorization: 'Удалить авторизацию',
  restart: 'Перезапустить',
  working: 'Выполняется…',
  actionFailed: 'Действие не удалось: {message}',
  lastError: 'Последняя ошибка',
}

/** Portuguese copy. */
export const pt: Record<McpSettingsLocaleKey, string> = {
  tab: 'Servidores MCP',
  description: 'Estado da conexão dos servidores MCP gerenciados por este Host. A autorização abre em uma aba do navegador e vale para todas as sessões que usam o servidor.',
  empty: 'Nenhum servidor MCP está configurado. Adicione um em “Configurações → Plugins” ou instale um plugin que registre um.',
  unavailable: 'Este cliente não consegue acessar o gerenciador de servidores MCP.',
  failedToLoad: 'Não foi possível ler a lista de servidores.',
  statusConnected: 'Conectado · {count} ferramentas',
  statusConnecting: 'Conectando',
  statusReconnecting: 'Reconectando · tentativa {attempt}/{max}',
  statusWaitingCredentials: 'Aguardando credenciais',
  statusWaitingAuthorization: 'Aguardando autorização',
  statusFailed: 'Falhou · {reason}',
  statusDisabled: 'Desativado',
  statusClosed: 'Fechado',
  reasonGaveUp: 'tentativas de reconexão esgotadas',
  reasonReconnectDisabled: 'reconexão desativada',
  reasonUnclosedGeneration: 'a conexão anterior não foi fechada',
  reasonLoad: 'o plugin não pôde ser carregado',
  reasonCleanup: 'a limpeza está incompleta',
  authorize: 'Autorizar',
  clearAuthorization: 'Limpar autorização',
  restart: 'Reiniciar',
  working: 'Processando…',
  actionFailed: 'A ação falhou: {message}',
  lastError: 'Último erro',
}
