// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { A2aStatusSection } from '../src/client/A2aStatusSection.tsx'
import type { A2aStatusSectionProps } from '../src/client/A2aStatusSection.tsx'
import { A2aStatusStore } from '../src/client/a2a-status-store.ts'
import type { A2aStatusState } from '../src/client/a2a-status-store.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** 把中文字典当作文案源，未知键原样返回，便于断言。 */
const t = (key: string): string => (zh as Record<string, string>)[key] ?? key

/**
 * 渲染状态分区。
 * @param patch - 覆盖到初始快照上的字段。
 * @param remote - 控制器调用 Remote 时的行为；默认永不结束，避免自动加载改变快照。
 * @returns 被注入的控制器与 store。
 */
function mount(patch: Partial<A2aStatusState>, remote?: () => Promise<never>) {
  const controller = new A2aStatusStore({ status: remote ?? (() => new Promise<never>(() => {})) })
  const store = createSnapshotStore<A2aStatusState>({
    status: 'ready',
    available: true,
    hostRunning: true,
    hostPort: 9310,
    kafkaPhase: 'ready',
    kafkaReady: true,
    kafkaBrokers: ['127.0.0.1:9092'],
    kafkaFailure: null,
    kafkaDiagnostic: '',
    error: null,
    ...patch,
  })
  const props = {
    controller,
    useSnapshot: bindSnapshotSelector(store),
    hooks: { snapshot: store },
    t,
  } as unknown as A2aStatusSectionProps
  render(<A2aStatusSection {...props} />)
  return { controller, store }
}

describe('A2aStatusSection', () => {
  it('就绪时显示主机端口与 Kafka 状态，不显示诊断', () => {
    mount({})
    expect(screen.getByText('运行中（端口 9310）')).toBeDefined()
    expect(screen.getByText('就绪')).toBeDefined()
    expect(screen.queryByText(zh.kafkaNoRuntime)).toBeNull()
    expect(screen.queryByText(/探测地址/)).toBeNull()
  })

  it('主机未运行时显示未运行文案', () => {
    mount({ hostRunning: false, hostPort: 0 })
    expect(screen.getByText('未运行')).toBeDefined()
    expect(document.querySelector('[data-host-running="false"]')).toBeDefined()
  })

  it('加载中只显示查询文案', () => {
    mount({ status: 'loading' })
    expect(screen.getByText(zh.loading)).toBeDefined()
    expect(screen.queryByText(zh.loadFailed)).toBeNull()
    expect(screen.queryByText(zh.hostStatus)).toBeNull()
  })

  it('查询失败时显示错误与重试按钮，点击会重新查询', async () => {
    const status = vi.fn<() => Promise<never>>(() => new Promise<never>(() => {}))
    const { controller } = mount({ status: 'error', error: 'Remote 拒绝' }, status)
    const spy = vi.spyOn(controller, 'load')
    expect(screen.getByRole('alert').textContent).toBe(zh.loadFailed)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('不可用且无运行时给出对应文案与探测地址', () => {
    mount({ kafkaPhase: 'unavailable', kafkaReady: false, kafkaFailure: 'no-runtime' })
    expect(screen.getByText('不可用')).toBeDefined()
    expect(screen.getByText(zh.kafkaNoRuntime)).toBeDefined()
    expect(screen.getByText(`${zh.kafkaBrokers}: 127.0.0.1:9092`)).toBeDefined()
  })

  it('启动失败时同时展示原因与原始诊断文本', () => {
    mount({
      kafkaPhase: 'unavailable',
      kafkaReady: false,
      kafkaFailure: 'start-failed',
      kafkaDiagnostic: 'docker compose 退出码 1：no such file',
    })
    expect(screen.getByText(zh.kafkaStartFailed)).toBeDefined()
    expect(screen.getByText(`${zh.kafkaDiagnostic}: docker compose 退出码 1：no such file`)).toBeDefined()
  })

  it('命令执行但未监听时给出第三种文案', () => {
    mount({ kafkaPhase: 'unavailable', kafkaReady: false, kafkaFailure: 'not-listening' })
    expect(screen.getByText(zh.kafkaNotListening)).toBeDefined()
  })

  it('失败类别未知时不显示原因行，只显示探测地址', () => {
    mount({ kafkaPhase: 'unavailable', kafkaReady: false, kafkaFailure: null })
    expect(document.querySelector('[class*="reason"]')).toBeNull()
    expect(screen.getByText(`${zh.kafkaBrokers}: 127.0.0.1:9092`)).toBeDefined()
  })

  it('无诊断文本时不渲染诊断行', () => {
    mount({ kafkaPhase: 'unavailable', kafkaReady: false, kafkaFailure: 'no-runtime', kafkaDiagnostic: '' })
    expect(screen.queryByText(new RegExp(zh.kafkaDiagnostic))).toBeNull()
  })

  it('启动中不显示诊断区块', () => {
    mount({ kafkaPhase: 'starting', kafkaReady: false, kafkaFailure: null })
    expect(screen.getByText('启动中…')).toBeDefined()
    expect(screen.queryByText(new RegExp(zh.kafkaBrokers))).toBeNull()
  })

  it('Kafka 行按 data-kafka-phase 输出阶段属性', () => {
    mount({ kafkaPhase: 'unavailable', kafkaReady: false, kafkaFailure: 'no-runtime' })
    expect(document.querySelector('[data-kafka-phase="unavailable"]')).toBeDefined()
  })

  it('文案字典的中英键集一致', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })
})
