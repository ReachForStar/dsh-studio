/**
 * a2a 服务状态指示器页面文案。中文为产品文案，英文镜像。
 */

/** 中文产品文案，键集来源。 */
export const zh = {
  nav: 'A2A 服务',
  description: '查询 A2A 主机和 Kafka 的运行状态',
  hostStatus: 'A2A 主机',
  hostRunning: '运行中（端口 {port}）',
  hostStopped: '未运行',
  kafkaStatus: 'Kafka',
  kafkaStarting: '启动中…',
  kafkaReady: '就绪',
  kafkaUnavailable: '不可用',
  kafkaNoRuntime: '本机未找到 Docker 或 WSL，且未设置 A2A_BUS_BOOTSTRAP。',
  kafkaStartFailed: 'Kafka 启动命令执行失败。',
  kafkaNotListening: '启动命令已执行，但 broker 未在预期时间内监听。',
  kafkaBrokers: '探测地址',
  kafkaDiagnostic: '失败详情',
  loading: '查询中…',
  loadFailed: '查询状态失败。',
  retry: '重试',
} satisfies Record<string, string>

/** 页面文案键，由中文字典推导。 */
export type A2aStatusLocaleKey = keyof typeof zh

/** 英文镜像，键集与中文对齐。 */
export const en = {
  nav: 'A2A Service',
  description: 'Query A2A host and Kafka runtime status.',
  hostStatus: 'A2A Host',
  hostRunning: 'Running (port {port})',
  hostStopped: 'Not running',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Starting…',
  kafkaReady: 'Ready',
  kafkaUnavailable: 'Unavailable',
  kafkaNoRuntime: 'No Docker or WSL found on this host, and A2A_BUS_BOOTSTRAP is unset.',
  kafkaStartFailed: 'The Kafka start command failed.',
  kafkaNotListening: 'The start command ran, but no broker listened within the expected time.',
  kafkaBrokers: 'Probed addresses',
  kafkaDiagnostic: 'Failure detail',
  loading: 'Querying…',
  loadFailed: 'Failed to query status.',
  retry: 'Retry',
} satisfies Record<A2aStatusLocaleKey, string>

/** Japanese mirror. */
export const ja = {
  nav: 'A2A サービス',
  description: 'A2A ホストと Kafka の実行状態を照会します。',
  hostStatus: 'A2A ホスト',
  hostRunning: '実行中（ポート {port}）',
  hostStopped: '停止中',
  kafkaStatus: 'Kafka',
  kafkaStarting: '起動中…',
  kafkaReady: '準備完了',
  kafkaUnavailable: '利用不可',
  kafkaNoRuntime: 'このホストに Docker も WSL もないため、A2A_BUS_BOOTSTRAP が未設定です。',
  kafkaStartFailed: 'Kafka の起動コマンドが失敗しました。',
  kafkaNotListening: '起動コマンドは実行されましたが、ブローカーが想定時間内に待ち受けませんでした。',
  kafkaBrokers: 'プローブ先',
  kafkaDiagnostic: '失敗の詳細',
  loading: '照会中…',
  loadFailed: '状態の照会に失敗しました。',
  retry: '再試行',
} satisfies Record<A2aStatusLocaleKey, string>

/** Spanish mirror. */
export const es = {
  nav: 'Servicio A2A',
  description: 'Consulta el estado del host A2A y de Kafka.',
  hostStatus: 'Host A2A',
  hostRunning: 'En ejecución (puerto {port})',
  hostStopped: 'Detenido',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Iniciando…',
  kafkaReady: 'Listo',
  kafkaUnavailable: 'No disponible',
  kafkaNoRuntime: 'No se encontró Docker ni WSL en este host y A2A_BUS_BOOTSTRAP no está definido.',
  kafkaStartFailed: 'El comando de inicio de Kafka falló.',
  kafkaNotListening: 'El comando de inicio se ejecutó, pero ningún broker escuchó en el tiempo esperado.',
  kafkaBrokers: 'Direcciones sondeadas',
  kafkaDiagnostic: 'Detalle del fallo',
  loading: 'Consultando…',
  loadFailed: 'No se pudo consultar el estado.',
  retry: 'Reintentar',
} satisfies Record<A2aStatusLocaleKey, string>

/** French mirror. */
export const fr = {
  nav: 'Service A2A',
  description: "Interroge l'état de l'hôte A2A et de Kafka.",
  hostStatus: 'Hôte A2A',
  hostRunning: 'En cours (port {port})',
  hostStopped: 'Arrêté',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Démarrage…',
  kafkaReady: 'Prêt',
  kafkaUnavailable: 'Indisponible',
  kafkaNoRuntime: "Aucun Docker ni WSL trouvé sur cet hôte, et A2A_BUS_BOOTSTRAP n'est pas défini.",
  kafkaStartFailed: 'La commande de démarrage de Kafka a échoué.',
  kafkaNotListening: "La commande de démarrage s'est exécutée, mais aucun broker n'a écouté dans le délai prévu.",
  kafkaBrokers: 'Adresses sondées',
  kafkaDiagnostic: "Détail de l'échec",
  loading: 'Interrogation…',
  loadFailed: "Impossible d'interroger l'état.",
  retry: 'Réessayer',
} satisfies Record<A2aStatusLocaleKey, string>

/** German mirror. */
export const de = {
  nav: 'A2A-Dienst',
  description: 'Fragt den Laufzeitstatus von A2A-Host und Kafka ab.',
  hostStatus: 'A2A-Host',
  hostRunning: 'Läuft (Port {port})',
  hostStopped: 'Nicht gestartet',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Wird gestartet…',
  kafkaReady: 'Bereit',
  kafkaUnavailable: 'Nicht verfügbar',
  kafkaNoRuntime: 'Auf diesem Host wurde weder Docker noch WSL gefunden, und A2A_BUS_BOOTSTRAP ist nicht gesetzt.',
  kafkaStartFailed: 'Der Kafka-Startbefehl ist fehlgeschlagen.',
  kafkaNotListening: 'Der Startbefehl wurde ausgeführt, aber kein Broker hat innerhalb der erwarteten Zeit gelauscht.',
  kafkaBrokers: 'Geprüfte Adressen',
  kafkaDiagnostic: 'Fehlerdetails',
  loading: 'Wird abgefragt…',
  loadFailed: 'Statusabfrage fehlgeschlagen.',
  retry: 'Erneut versuchen',
} satisfies Record<A2aStatusLocaleKey, string>

/** Russian mirror. */
export const ru = {
  nav: 'Служба A2A',
  description: 'Проверяет состояние хоста A2A и Kafka.',
  hostStatus: 'Хост A2A',
  hostRunning: 'Работает (порт {port})',
  hostStopped: 'Не запущен',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Запуск…',
  kafkaReady: 'Готово',
  kafkaUnavailable: 'Недоступно',
  kafkaNoRuntime: 'На этом хосте нет Docker или WSL, а A2A_BUS_BOOTSTRAP не задан.',
  kafkaStartFailed: 'Команда запуска Kafka завершилась с ошибкой.',
  kafkaNotListening: 'Команда запуска выполнена, но брокер не начал прослушивание за ожидаемое время.',
  kafkaBrokers: 'Проверяемые адреса',
  kafkaDiagnostic: 'Подробности ошибки',
  loading: 'Запрос…',
  loadFailed: 'Не удалось получить состояние.',
  retry: 'Повторить',
} satisfies Record<A2aStatusLocaleKey, string>

/** Portuguese mirror. */
export const pt = {
  nav: 'Serviço A2A',
  description: 'Consulta o estado do host A2A e do Kafka.',
  hostStatus: 'Host A2A',
  hostRunning: 'Em execução (porta {port})',
  hostStopped: 'Parado',
  kafkaStatus: 'Kafka',
  kafkaStarting: 'Iniciando…',
  kafkaReady: 'Pronto',
  kafkaUnavailable: 'Indisponível',
  kafkaNoRuntime: 'Nenhum Docker ou WSL encontrado neste host, e A2A_BUS_BOOTSTRAP não está definido.',
  kafkaStartFailed: 'O comando de inicialização do Kafka falhou.',
  kafkaNotListening: 'O comando de inicialização foi executado, mas nenhum broker escutou no tempo esperado.',
  kafkaBrokers: 'Endereços sondados',
  kafkaDiagnostic: 'Detalhe da falha',
  loading: 'Consultando…',
  loadFailed: 'Falha ao consultar o estado.',
  retry: 'Tentar novamente',
} satisfies Record<A2aStatusLocaleKey, string>
