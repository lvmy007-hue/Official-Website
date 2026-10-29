import { describe, expect, it } from 'vitest'
import { assertRemoteUrl, remoteUrlProblem } from './remote-url'

describe('remoteUrlProblem', () => {
  it('放行亚马逊常见的预签名下载地址与测试里的短主机名', () => {
    for (const ok of [
      'https://tortuga-prod-na.s3-external-1.amazonaws.com/doc?X-Amz-Signature=abc',
      'https://offline-report-storage.s3.amazonaws.com/x.gz',
      'https://dl/x',
      'https://8.8.8.8/x',
      'https://[2606:4700::1111]/x',
    ]) {
      expect(remoteUrlProblem(ok), ok).toBeNull()
    }
  })

  it('拒绝非加密地址、账号信息与格式错误', () => {
    expect(remoteUrlProblem('http://s3.amazonaws.com/x')).toBe('不是加密地址')
    expect(remoteUrlProblem('ftp://example.com/x')).toBe('不是加密地址')
    expect(remoteUrlProblem('https://user:pass@example.com/x')).toBe('地址里带有账号信息')
    expect(remoteUrlProblem('not a url')).toBe('地址格式不正确')
    expect(remoteUrlProblem('')).toBe('地址格式不正确')
  })

  it('拒绝本机、内网、链路本地与元数据地址（IPv4 与 IPv6）', () => {
    for (const bad of [
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://172.16.0.1/x',
      'https://172.31.255.255/x',
      'https://192.168.1.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://100.64.0.1/x',
      'https://0.0.0.0/x',
      'https://224.0.0.1/x',
      'https://[::1]/x',
      'https://[::ffff:10.0.0.1]/x',
      'https://[fd00::1]/x',
      'https://[fe80::1]/x',
    ]) {
      expect(remoteUrlProblem(bad), bad).toBe('指向内网或保留地址')
    }
  })

  it('拒绝本机与内网域名；邻近的公网段不误伤', () => {
    for (const bad of ['https://localhost/x', 'https://LOCALHOST/x', 'https://db.internal/x', 'https://printer.local/x', 'https://a.b.localhost/x'])
      expect(remoteUrlProblem(bad), bad).toBe('指向本机或内网域名')
    for (const ok of ['https://172.15.0.1/x', 'https://172.32.0.1/x', 'https://100.63.0.1/x', 'https://11.0.0.1/x']) expect(remoteUrlProblem(ok), ok).toBeNull()
  })
})

describe('assertRemoteUrl', () => {
  it('通过时返回地址，失败时抛不可重试错误并带上说明', () => {
    expect(assertRemoteUrl('https://example.com/a', '报告下载地址')).toBe('https://example.com/a')
    expect(() => assertRemoteUrl('https://127.0.0.1/a', '报告下载地址')).toThrow(/报告下载地址被拒绝：指向内网或保留地址/)
    try {
      assertRemoteUrl('http://example.com/a', '反馈文件地址')
    } catch (error) {
      expect(error).toMatchObject({ code: 'REMOTE_URL_REJECTED', retryable: false })
    }
  })
})
