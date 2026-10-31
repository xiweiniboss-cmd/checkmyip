// 在页面渲染前确定主题，避免闪烁：优先用户选择，其次跟随系统
(function () {
  var t = null;
  try { t = localStorage.getItem('cmi-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
