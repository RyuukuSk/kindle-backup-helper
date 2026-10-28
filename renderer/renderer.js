const MODE_DETAILS = [
  '书籍 → 备份文件夹（无容量上限）',
  'KOReader / 越狱 / 字体 → 镜像，不含图书',
  '环境进镜像 + 图书进文件夹'
];

let currentMode = 0;
let currentDest = '';
let busy = false;

const $ = (id) => document.getElementById(id);

// 元素
const modeSegment = $('modeSegment');
const modeDetail = $('modeDetail');
const destSelect = $('destSelect');
const destPathLabel = $('destPathLabel');
const backupBtn = $('backupBtn');
const restoreBtn = $('restoreBtn');
const cancelBtn = $('cancelBtn');
const progressFill = $('progressFill');
const percentLabel = $('percentLabel');
const statusLabel = $('statusLabel');
const logToggleBtn = $('logToggleBtn');
const logBox = $('logBox');
const logContent = $('logContent');
const connectionDot = $('connectionDot');
const connectionLabel = $('connectionLabel');

// 日志
function appendLog(s) {
  logContent.textContent += s + '\n';
  logBox.scrollTop = logBox.scrollHeight;
}

// 连接状态
function setConnection(connected) {
  if (connected) {
    connectionDot.className = 'dot green';
    connectionLabel.textContent = 'Kindle 已连接';
  } else {
    connectionDot.className = 'dot red';
    connectionLabel.textContent = 'Kindle 未连接';
  }
}

// 更新目标路径显示
function updateDestLabel() {
  destPathLabel.textContent = currentDest || '';
}

// 分段切换
modeSegment.querySelectorAll('.seg').forEach(btn => {
  btn.addEventListener('click', () => {
    modeSegment.querySelectorAll('.seg').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentMode = parseInt(btn.dataset.mode);
    modeDetail.textContent = MODE_DETAILS[currentMode];
  });
});

// 目标位置切换
destSelect.addEventListener('change', () => {
  currentDest = destSelect.value;
  updateDestLabel();
});

// 选择文件夹
$('chooseDirBtn').addEventListener('click', async () => {
  const dir = await window.api.chooseDir();
  if (dir) {
    currentDest = dir;
    updateDestLabel();
  }
});

// 选择映像
$('chooseImageBtn').addEventListener('click', async () => {
  const img = await window.api.chooseImage();
  if (img) {
    appendLog('已选择映像: ' + img);
  }
});

// 开始备份
backupBtn.addEventListener('click', async () => {
  if (busy) return;
  if (!currentDest) {
    alert('请先选择备份位置（点击「选择文件夹…」或在下拉框中选择磁盘）');
    return;
  }
  busy = true;
  backupBtn.disabled = true;
  restoreBtn.disabled = true;
  cancelBtn.disabled = false;
  percentLabel.textContent = '0%';
  progressFill.style.width = '0%';
  statusLabel.textContent = '备份中…';
  await window.api.startBackup(currentMode, currentDest);
});

// 还原
restoreBtn.addEventListener('click', async () => {
  if (busy) return;
  if (!currentDest) {
    alert('请先选择备份所在的位置（点击「选择文件夹…」）');
    return;
  }
  busy = true;
  backupBtn.disabled = true;
  restoreBtn.disabled = true;
  cancelBtn.disabled = false;
  percentLabel.textContent = '0%';
  statusLabel.textContent = '还原中…';
  await window.api.startRestore(currentMode, currentDest);
});

// 取消
cancelBtn.addEventListener('click', async () => {
  await window.api.cancel();
});

// 日志展开
logToggleBtn.addEventListener('click', () => {
  const hidden = logBox.hidden;
  logBox.hidden = !hidden;
  logToggleBtn.textContent = hidden ? '收起日志 ▴' : '展开日志 ▾';
});

// 事件监听
window.api.onLog((s) => appendLog(s));
window.api.onProgress((v, msg) => {
  progressFill.style.width = (v * 100) + '%';
  percentLabel.textContent = Math.round(v * 100) + '%';
  statusLabel.textContent = msg;
});
window.api.onFinish((ok, msg) => {
  busy = false;
  backupBtn.disabled = false;
  restoreBtn.disabled = false;
  cancelBtn.disabled = true;
  statusLabel.textContent = (ok ? '✅ ' : '❌ ') + msg;
  if (!ok) {
    alert(msg);
  }
});

// 初始化
(async () => {
  const status = await window.api.getStatus();
  setConnection(status.connected);

  // 填充目标位置选项（不预选，保持「请选择备份位置…」占位）
  status.destOptions.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.path;
    o.textContent = opt.label;
    destSelect.appendChild(o);
  });
  currentDest = '';
  destSelect.value = '';
  updateDestLabel();

  appendLog('欢迎使用 Kindle 备份助手');
  appendLog('平台: ' + (status.platform === 'darwin' ? 'macOS' : 'Windows'));
  appendLog('请先选择备份位置，再开始备份或还原');

  // 定时刷新连接状态
  setInterval(async () => {
    const s = await window.api.getStatus();
    setConnection(s.connected);
  }, 2000);
})();
