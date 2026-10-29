// 跳转到亚马逊的授权页：单独成函数，页面测试里替换掉它（jsdom 不能真的导航）。
export function goToAuthorization(url: string): void {
  window.location.assign(url)
}
