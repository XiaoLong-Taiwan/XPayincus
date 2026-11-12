const en = {
  title: 'Agent monitoring', window: 'Time window', hour: 'Last hour', day: 'Last 24 hours', week: 'Last 7 days', month: 'Last 30 days',
  refresh: 'Refresh', loading: 'Loading…', empty: 'No samples in this window', error: 'Unable to load monitoring data. Retry to refresh.',
  host: 'Host history', metric: 'Metric', resolution: 'Bucket size', minute: '1 minute', fiveMinutes: '5 minutes', oneHour: '1 hour', sixHours: '6 hours',
  min: 'Minimum', max: 'Maximum', avg: 'Average', count: 'Samples', coverage: 'Coverage', period: 'Period', summary: 'Window summary',
  coverageHint: 'Coverage is the fraction of this period covered by sample intervals, not uptime. Missing values are not zero.',
  capacity: 'Storage capacity was reached; retained data may be incomplete.', buckets: 'Only the most recent buckets are shown.',
  topTitle: 'Instance Top N', order: 'Rank by', top: 'Number of instances', instance: 'Instance', select: 'View history',
  instanceHistory: 'Instance history', historyHint: 'Shows this instance’s window summary and time buckets for the selected metric. Missing samples are not zero usage.',
  choose: 'Select an instance from the ranking to view its history.',
  events: 'Component changes', baseline: 'First snapshot in this result; earlier state is unavailable.', unchanged: 'No field changes',
  before: 'Before', after: 'After', missing: 'Not present', yes: 'Yes', no: 'No', nullValue: 'Null', eventsTruncated: 'Only the most recent component events are shown.',
  cpuUsagePercent: 'CPU usage (%)', memoryUsedBytes: 'Memory used (bytes)', diskReadBytesPerSecond: 'Disk read (bytes/s)', diskWriteBytesPerSecond: 'Disk write (bytes/s)', diskIOBytesPerSecond: 'Disk I/O (bytes/s)',
  cpuTotal: 'CPU cores', memoryTotalMb: 'Total memory (MiB)', memoryAvailableMb: 'Available memory (MiB)', memoryUsedMb: 'Used memory (MiB)', memoryUsagePercent: 'Memory usage (%)',
  swapTotalMb: 'Total swap (MiB)', swapUsedMb: 'Used swap (MiB)', swapUsagePercent: 'Swap usage (%)', diskTotalBytes: 'Total disk (bytes)', diskUsedBytes: 'Used disk (bytes)', diskAvailableBytes: 'Available disk (bytes)', diskUsagePercent: 'Disk usage (%)', processCount: 'Processes', load1: 'Load · 1 minute', load5: 'Load · 5 minutes', load15: 'Load · 15 minutes', uptimeSeconds: 'Uptime (seconds)',
  psi: 'Pressure stall information (PSI)', cpu: 'CPU', memory: 'Memory', io: 'I/O', some: 'Some tasks stalled', full: 'All tasks stalled', avg10: '10-second average (%)', avg60: '60-second average (%)', avg300: '300-second average (%)', total: 'Cumulative stall (µs)',
  psiHint: 'PSI averages are percentages. Total counters show cumulative readings and valid observed waiting increments in microseconds, not gauge averages.',
  first: 'First reading (µs)', last: 'Last reading (µs)', delta: 'Valid waiting increment (µs)', resetCount: 'Detected resets',
  counterHint: 'Increments use adjacent readings within this period, at most one hour apart, excluding counter decreases and detected reboots. Coverage includes only those valid intervals. Bucket increments may not sum to the window increment because pairs crossing bucket boundaries are excluded.',
  counterUnavailable: 'No valid interval; waiting increment is unknown',
  enabled: 'Enabled', status: 'Status', version: 'Version', available: 'Available', installed: 'Installed', running: 'Running', healthy: 'Healthy', errorField: 'Error', state: 'State'
}

type Copy = { [K in keyof typeof en]: string }

const zhTW: Copy = {
  title: 'Agent 監控', window: '時間窗', hour: '最近 1 小時', day: '最近 24 小時', week: '最近 7 天', month: '最近 30 天',
  refresh: '重新整理', loading: '載入中…', empty: '此時間窗沒有樣本', error: '無法載入監控資料，請重新整理重試。',
  host: '宿主歷史', metric: '指標', resolution: '分桶大小', minute: '1 分鐘', fiveMinutes: '5 分鐘', oneHour: '1 小時', sixHours: '6 小時',
  min: '最小值', max: '最大值', avg: '平均值', count: '樣本數', coverage: '涵蓋率', period: '時段', summary: '時間窗彙總',
  coverageHint: '涵蓋率是樣本區間涵蓋此時段的比例，不代表在線率。缺失值不視為零。',
  capacity: '儲存容量曾達上限，保留資料可能不完整。', buckets: '僅顯示最近的部分分桶。',
  topTitle: '實例 Top N', order: '排序依據', top: '實例數量', instance: '實例', select: '查看歷史',
  instanceHistory: '單實例歷史', historyHint: '顯示此實例所選指標的時間窗彙總與分桶歷史。缺少樣本不代表用量為零。',
  choose: '從排行榜選取實例以查看歷史。',
  events: '元件變更', baseline: '本次結果的首筆快照，先前狀態未知。', unchanged: '沒有欄位變更',
  before: '變更前', after: '變更後', missing: '不存在', yes: '是', no: '否', nullValue: '空值', eventsTruncated: '僅顯示最近的部分元件事件。',
  cpuUsagePercent: 'CPU 使用率（%）', memoryUsedBytes: '記憶體用量（bytes）', diskReadBytesPerSecond: '磁碟讀取（bytes/s）', diskWriteBytesPerSecond: '磁碟寫入（bytes/s）', diskIOBytesPerSecond: '磁碟 I/O（bytes/s）',
  cpuTotal: 'CPU 核心數', memoryTotalMb: '記憶體總量（MiB）', memoryAvailableMb: '可用記憶體（MiB）', memoryUsedMb: '已用記憶體（MiB）', memoryUsagePercent: '記憶體使用率（%）',
  swapTotalMb: 'Swap 總量（MiB）', swapUsedMb: '已用 Swap（MiB）', swapUsagePercent: 'Swap 使用率（%）', diskTotalBytes: '磁碟總量（bytes）', diskUsedBytes: '已用磁碟（bytes）', diskAvailableBytes: '可用磁碟（bytes）', diskUsagePercent: '磁碟使用率（%）', processCount: '程序數', load1: '負載 · 1 分鐘', load5: '負載 · 5 分鐘', load15: '負載 · 15 分鐘', uptimeSeconds: '運行時間（秒）',
  psi: '壓力停滯資訊（PSI）', cpu: 'CPU', memory: '記憶體', io: 'I/O', some: '部分工作停滯', full: '全部工作停滯', avg10: '10 秒平均（%）', avg60: '60 秒平均（%）', avg300: '300 秒平均（%）', total: '累計停滯（µs）',
  psiHint: 'PSI 平均值為百分比。total 計數器以微秒顯示累計讀值與有效觀測等待增量，不呈現一般指標平均值。',
  first: '首筆讀值（µs）', last: '末筆讀值（µs）', delta: '有效等待增量（µs）', resetCount: '偵測重設次數',
  counterHint: '增量只計入此時段內相隔不超過一小時的相鄰讀值，排除計數器下降與偵測到的重啟；涵蓋率僅計有效區間。分桶排除跨桶讀值配對，因此各桶增量加總可能不等於時間窗增量。',
  counterUnavailable: '沒有有效區間，等待增量未知',
  enabled: '已啟用', status: '狀態', version: '版本', available: '可用', installed: '已安裝', running: '運行中', healthy: '健康', errorField: '錯誤', state: '狀態'
}

const zhCN: Copy = {
  title: 'Agent 监控', window: '时间窗', hour: '最近 1 小时', day: '最近 24 小时', week: '最近 7 天', month: '最近 30 天',
  refresh: '刷新', loading: '加载中…', empty: '此时间窗没有样本', error: '无法加载监控数据，请刷新重试。',
  host: '宿主历史', metric: '指标', resolution: '分桶大小', minute: '1 分钟', fiveMinutes: '5 分钟', oneHour: '1 小时', sixHours: '6 小时',
  min: '最小值', max: '最大值', avg: '平均值', count: '样本数', coverage: '覆盖率', period: '时段', summary: '时间窗汇总',
  coverageHint: '覆盖率是样本区间覆盖此时段的比例，不代表在线率。缺失值不视为零。',
  capacity: '存储容量曾达上限，保留数据可能不完整。', buckets: '仅显示最近的部分分桶。',
  topTitle: '实例 Top N', order: '排序依据', top: '实例数量', instance: '实例', select: '查看历史',
  instanceHistory: '单实例历史', historyHint: '显示此实例所选指标的时间窗汇总与分桶历史。缺少样本不代表用量为零。',
  choose: '从排行榜选择实例以查看历史。',
  events: '组件变更', baseline: '本次结果的首条快照，先前状态未知。', unchanged: '没有字段变更',
  before: '变更前', after: '变更后', missing: '不存在', yes: '是', no: '否', nullValue: '空值', eventsTruncated: '仅显示最近的部分组件事件。',
  cpuUsagePercent: 'CPU 使用率（%）', memoryUsedBytes: '内存用量（bytes）', diskReadBytesPerSecond: '磁盘读取（bytes/s）', diskWriteBytesPerSecond: '磁盘写入（bytes/s）', diskIOBytesPerSecond: '磁盘 I/O（bytes/s）',
  cpuTotal: 'CPU 核心数', memoryTotalMb: '内存总量（MiB）', memoryAvailableMb: '可用内存（MiB）', memoryUsedMb: '已用内存（MiB）', memoryUsagePercent: '内存使用率（%）',
  swapTotalMb: 'Swap 总量（MiB）', swapUsedMb: '已用 Swap（MiB）', swapUsagePercent: 'Swap 使用率（%）', diskTotalBytes: '磁盘总量（bytes）', diskUsedBytes: '已用磁盘（bytes）', diskAvailableBytes: '可用磁盘（bytes）', diskUsagePercent: '磁盘使用率（%）', processCount: '进程数', load1: '负载 · 1 分钟', load5: '负载 · 5 分钟', load15: '负载 · 15 分钟', uptimeSeconds: '运行时间（秒）',
  psi: '压力停滞信息（PSI）', cpu: 'CPU', memory: '内存', io: 'I/O', some: '部分任务停滞', full: '全部任务停滞', avg10: '10 秒平均（%）', avg60: '60 秒平均（%）', avg300: '300 秒平均（%）', total: '累计停滞（µs）',
  psiHint: 'PSI 平均值为百分比。total 计数器以微秒显示累计读值与有效观测等待增量，不呈现一般指标平均值。',
  first: '首条读值（µs）', last: '末条读值（µs）', delta: '有效等待增量（µs）', resetCount: '检测重置次数',
  counterHint: '增量仅计入此时段内相隔不超过一小时的相邻读值，排除计数器下降与检测到的重启；覆盖率仅计有效区间。分桶排除跨桶读值配对，因此各桶增量之和可能不等于时间窗增量。',
  counterUnavailable: '没有有效区间，等待增量未知',
  enabled: '已启用', status: '状态', version: '版本', available: '可用', installed: '已安装', running: '运行中', healthy: '健康', errorField: '错误', state: '状态'
}

export const agentMonitoringCopy = { 'zh-TW': zhTW, 'zh-CN': zhCN, en }
export type MonitoringCopyKey = keyof Copy
