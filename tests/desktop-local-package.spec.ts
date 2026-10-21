import { expect, it } from 'vitest'
import { createElectronBuilderConfig } from '../apps/desktop/scripts/electron-builder-config.mjs'
import { localUnsignedPackageEnvironment, validateDesktopPackageEnvironment } from '../apps/desktop/scripts/desktop-package-environment.mjs'

it.each(['linux', 'win32', 'darwin'] as const)('为 %s 生成不依赖发布服务的安装包并保留 Linux 双格式', (platform) => {
  const environment = localUnsignedPackageEnvironment({})
  expect(() => { validateDesktopPackageEnvironment(environment, { platform, arch: 'x64' }, { unsigned: true }) }).not.toThrow()
  const config = createElectronBuilderConfig(environment, platform, 'x64')
  expect(config.linux.target).toEqual(['AppImage', 'deb'])
  expect(config.deb.packageName).toBe('deepseek-harness')
  expect(config.extraMetadata.dshMandatoryUpdatePolicy).toBeUndefined()
  expect(config.publish).toBeNull()
})

it('发布构建拒绝缺少服务配置', () => {
  expect(() => {
    validateDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.deepseek.harness' }, { platform: 'linux', arch: 'x64' })
  }).toThrow()
})
