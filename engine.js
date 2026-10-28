const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

// 备份模式
const MODES = {
  booksOnly: 0,
  noBooks: 1,
  full: 2
};

const BOOK_EXTS = ['azw', 'azw3', 'mobi', 'epub', 'pdf', 'kf8', 'azw4', 'prc'];
// 仅「检测含图书的文件夹」时跳过这些系统/插件目录（避免把插件目录误判为图书目录）。
// 注意：环境备份/全量备份使用 copyDir 全量遍历，不受此集合影响，会完整包含
// koreader、extensions、mrpackages 等越狱插件目录。
const SKIP_DIRS = new Set(['system', 'extensions', 'apps', 'koreader',
  'libkh', 'mesquito', 'mrpackages', 'kmc', 'fonts']);

class BackupEngine {
  constructor() {
    this.onLog = null;
    this.onProgress = null;
    this.onFinish = null;
    this.cancelled = false;
    this.currentProc = null;
    this.isMac = process.platform === 'darwin';
    this.isWin = process.platform === 'win32';
  }

  log(s) { if (this.onLog) this.onLog(s); }
  progress(v, msg) { if (this.onProgress) this.onProgress(v, msg); }
  finish(ok, msg) { if (this.onFinish) this.onFinish(ok, msg); }

  cancel() {
    this.cancelled = true;
    if (this.currentProc) {
      try { this.currentProc.kill(); } catch (e) {}
    }
  }

  // ===== Kindle 挂载检测 =====
  locateKindle() {
    if (this.isMac) {
      // macOS: /Volumes 下找含 documents 的卷
      const volRoot = '/Volumes';
      try {
        const vols = fs.readdirSync(volRoot);
        for (const v of vols) {
          if (v === 'Macintosh HD') continue;
          const p = path.join(volRoot, v);
          if (fs.existsSync(path.join(p, 'documents'))) return p;
        }
      } catch (e) {}
      return null;
    } else if (this.isWin) {
      // Windows: 遍历盘符，找含 documents 的可移动盘
      const driveLetters = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];
      for (const letter of driveLetters) {
        const drive = letter + ':\\';
        try {
          if (fs.existsSync(path.join(drive, 'documents'))) return drive;
        } catch (e) {}
      }
      return null;
    }
    return null;
  }

  // ===== 目标位置 =====
  // 默认返回空字符串：不预填备份位置，要求用户主动选择，避免写入非预期目录
  getDefaultDest() {
    return '';
  }

  getDestOptions() {
    const opts = [];
    if (this.isMac) {
      // macOS 列出 /Volumes 下除系统盘外的可写卷（不含个人路径硬编码）
      try {
        const volRoot = '/Volumes';
        const vols = fs.readdirSync(volRoot);
        for (const v of vols) {
          if (v === 'Macintosh HD' || v === 'Recovery' || v.startsWith('.')) continue;
          const p = path.join(volRoot, v);
          try {
            const st = fs.statSync(p);
            if (!st.isDirectory()) continue;
            // 仅列出看起来可写的非系统卷
            opts.push({ label: '磁盘「' + v + '」', path: p });
          } catch (e) {}
        }
      } catch (e) {}
    } else {
      // Windows 检查非系统盘
      for (const letter of ['D', 'E', 'F', 'G']) {
        const drive = letter + ':\\';
        try { if (fs.existsSync(drive)) { opts.push({ label: letter + ' 盘', path: path.join(drive, 'Kindle备份') }); } } catch (e) {}
      }
    }
    // 不再自动追加默认目录；用户通过「选择文件夹」指定
    return opts;
  }

  // ===== 检测含图书的文件夹 =====
  detectBookDirs(kindle) {
    const result = [];
    try {
      const items = fs.readdirSync(kindle);
      for (const item of items.sort()) {
        if (item.startsWith('.') || SKIP_DIRS.has(item)) continue;
        const full = path.join(kindle, item);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (stat.isDirectory() && this.dirContainsBooks(full)) result.push(full);
      }
    } catch (e) {}
    return result;
  }

  dirContainsBooks(dir) {
    try {
      const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d); } catch (e) { return false; }
        for (const name of entries) {
          const full = path.join(d, name);
          let st;
          try { st = fs.statSync(full); } catch (e) { continue; }
          if (st.isDirectory()) {
            if (walk(full)) return true;
          } else {
            const lower = name.toLowerCase();
            if (BOOK_EXTS.some(ext => lower.endsWith('.' + ext))) return true;
          }
        }
        return false;
      };
      return walk(dir);
    } catch (e) { return false; }
  }

  // ===== 跨平台文件复制（替代 rsync）=====
  async copyDir(src, dst, { exclude = [], include = [], onFile = null, skipMacJunk = true } = {}) {
    const files = [];
    const dirs = [];
    const walk = (d, base) => {
      let entries;
      try { entries = fs.readdirSync(d); } catch (e) { return; }
      for (const name of entries) {
        if (skipMacJunk && (name === '.DS_Store' || name.startsWith('._') ||
            name === '.fseventsd' || name === '.Spotlight-V100' || name === '.Trashes' || name === '.TemporaryItems')) {
          continue;
        }
        if (exclude.some(e => name === e || name.endsWith('/') === false && name === e)) continue;
        const full = path.join(d, name);
        let st;
        try { st = fs.statSync(full); } catch (e) { continue; }
        const rel = base ? path.join(base, name) : name;
        if (st.isDirectory()) {
          dirs.push(rel);
          walk(full, rel);
        } else {
          // include 过滤（只保留指定扩展名）
          if (include.length > 0) {
            const lower = name.toLowerCase();
            if (!include.some(ext => lower.endsWith('.' + ext))) continue;
          }
          files.push({ src: full, rel });
        }
      }
    };
    walk(src, '');

    // 先创建所有目录（含空目录），保证目录结构完整还原
    for (const d of dirs) {
      try { fs.mkdirSync(path.join(dst, d), { recursive: true }); } catch (e) {}
    }

    const total = files.length;
    let done = 0;
    for (const f of files) {
      if (this.cancelled) throw new Error('已取消');
      const target = path.join(dst, f.rel);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(f.src, target);
      } catch (e) {
        this.log('⚠️ 复制失败: ' + f.rel + ' (' + e.message + ')');
      }
      done++;
      if (onFile) onFile(done, total, f.rel);
    }
    return total;
  }

  // ===== 备份图书 =====
  async backupBooks(destRoot) {
    const kindle = this.locateKindle();
    if (!kindle) { this.finish(false, '未找到 Kindle 设备，请先通过 USB 连接'); return; }

    const bookDirs = this.detectBookDirs(kindle);
    if (bookDirs.length === 0) {
      this.finish(false, '未在 Kindle 上检测到含图书的文件夹');
      return;
    }
    this.log('检测到图书文件夹: ' + bookDirs.map(d => path.basename(d)).join('、'));

    const dst = path.join(destRoot, '图书');
    fs.mkdirSync(dst, { recursive: true });

    let grandTotal = 0, grandDone = 0;
    for (const dir of bookDirs) {
      const name = path.basename(dir);
      let targetDir = dst;
      let include = [];
      if (name !== '图书') {
        targetDir = path.join(dst, name);
        include = BOOK_EXTS;
      }
      this.log('▶ 备份「' + name + '」开始');
      const cnt = await this.copyDir(dir, targetDir, { include, onFile: (done, total) => {
        grandDone++;
        grandTotal = Math.max(grandTotal, total);
        const frac = grandTotal > 0 ? Math.min(grandDone / grandTotal, 0.99) : 0;
        this.progress(frac, `备份「${name}」：已处理 ${done}/${total} 个文件`);
      }});
      this.log('✅ 「' + name + '」完成，共 ' + cnt + ' 个文件');
    }
    this.progress(1.0, '完成');
    this.finish(true, '图书备份成功');
  }

  // ===== 镜像备份（macOS 用 hdiutil，Windows 用目录复制模拟）=====
  async backupToImage(imgPath, excludeBooks) {
    const kindle = this.locateKindle();
    if (!kindle) { this.finish(false, '未找到 Kindle 设备，请先通过 USB 连接'); return; }

    if (this.isMac) {
      // macOS: 挂载镜像 → rsync 同步
      await this.macImageSync(imgPath, kindle, excludeBooks);
    } else if (this.isWin) {
      // Windows: 用目录方式模拟镜像备份（把环境内容复制到目标文件夹）
      const label = excludeBooks ? '环境备份' : '全量备份';
      this.log('Windows 环境：使用目录方式备份（' + label + '）');
      const targetDir = imgPath.replace(/\.(img|dmg|iso)$/i, '') + '_备份目录';
      fs.mkdirSync(targetDir, { recursive: true });
      const exclude = excludeBooks ? ['图书'] : [];
      await this.copyDir(kindle, targetDir, { exclude, onFile: (done, total) => {
        this.progress(Math.min(done / Math.max(total, 1), 0.99), `${label}：已处理 ${done}/${total} 个文件`);
      }});
      this.progress(1.0, '完成');
      this.finish(true, label + '成功');
    }
  }

  macImageSync(imgPath, kindle, excludeBooks) {
    return new Promise((resolve) => {
      const label = excludeBooks ? '环境备份' : '全量备份';
      // 使用唯一挂载点，避免固定路径残留导致挂载冲突或误写
      const mountPoint = '/Volumes/KindleBackup-' + Date.now();

      // 挂载镜像
      this.log('挂载镜像: ' + imgPath);
      const attachArgs = ['attach', '-mountpoint', mountPoint, '-nobrowse', '-readonly', imgPath];
      execFile('/usr/bin/hdiutil', attachArgs, { env: { ...process.env, LC_ALL: 'C' } }, (err) => {
        if (err) {
          this.finish(false, '挂载镜像失败: ' + err.message);
          resolve();
          return;
        }
        setTimeout(() => this.doRsync(kindle, mountPoint, excludeBooks, label, resolve, imgPath), 1000);
      });
    });
  }

  doRsync(kindle, mountPoint, excludeBooks, label, resolve, imgPath) {
    const excludes = ['--exclude=._*', '--exclude=.DS_Store', '--exclude=.fseventsd/', '--exclude=.Spotlight-V100/', '--exclude=.Trashes/', '--exclude=.TemporaryItems/'];
    if (excludeBooks) excludes.push('--exclude=图书/');

    // 先 dry-run 统计文件数
    const src = kindle.endsWith('/') ? kindle : kindle + '/';
    const dst = mountPoint.endsWith('/') ? mountPoint : mountPoint + '/';

    const rsyncPath = '/usr/bin/rsync';
    const probeArgs = ['-rt', '--no-owner', '--no-group', ...excludes, '-n', '--stats', src, dst];
    execFile(rsyncPath, probeArgs, { env: { ...process.env, LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } }, (err, stdout) => {
      if (err) {
        this.log('⚠️ rsync 探测失败: ' + (err.message || ''));
      }
      let total = 0;
      const lines = (stdout || '').split('\n');
      for (const line of lines) {
        if (line.startsWith('Number of files transferred:')) {
          total = parseInt(line.split(':')[1]) || 0;
        }
      }
      if (total === 0) {
        this.log('✅ 已是最新，无需更新');
        this.progress(1.0, '已是最新');
        this.finish(true, label + '完成（已是最新）');
        // 卸载
        execFile('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { env: { ...process.env, LC_ALL: 'C' } }, () => {});
        resolve();
        return;
      }
      this.log('待更新文件: ' + total);

      // 实际 rsync（去掉 --delete，避免误删；备份目标是只读镜像，增量安全）
      const realArgs = ['-rt', '--no-owner', '--no-group', ...excludes, '-v', src, dst];
      const proc = spawn(rsyncPath, realArgs, { env: { ...process.env, LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
      this.currentProc = proc;

      let buf = '';
      let processed = 0;
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          if (line.startsWith('building file list') || line.startsWith('sent ') ||
              line.startsWith('total size') || line.startsWith('created directory')) continue;
          if (line.endsWith('/')) continue;
          processed++;
          const frac = total > 0 ? Math.min(processed / total, 0.99) : 0;
          this.progress(frac, `${label}：已处理 ${processed}/${total} 个文件`);
        }
      });
      proc.on('close', (code) => {
        this.currentProc = null;
        // 卸载
        execFile('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { env: { ...process.env, LC_ALL: 'C' } }, () => {});
        if (this.cancelled) { this.finish(false, '已取消'); resolve(); return; }
        if (code === 0) {
          this.log('✅ ' + label + ' 完成');
          this.progress(1.0, '完成');
          this.finish(true, label + '成功');
        } else {
          this.finish(false, label + '失败（rsync 返回码 ' + code + '）');
        }
        resolve();
      });
    });
  }

  // ===== 还原 =====
  async startRestore(mode, dest) {
    const kindle = this.locateKindle();
    if (!kindle) { this.finish(false, '未找到 Kindle 设备，请先通过 USB 连接'); return; }

    if (mode === MODES.booksOnly) {
      const src = path.join(dest, '图书');
      if (!fs.existsSync(src)) { this.finish(false, '在 ' + dest + ' 下没有找到「图书」文件夹'); return; }
      const target = path.join(kindle, '图书');
      fs.mkdirSync(target, { recursive: true });
      await this.copyDir(src, target, { onFile: (done, total) => {
        this.progress(Math.min(done / Math.max(total, 1), 0.99), `还原图书：已处理 ${done}/${total} 个文件`);
      }});
      this.progress(1.0, '完成');
      this.finish(true, '图书还原成功');
      return;
    }

    // 环境备份 / 全量备份还原
    const label = (mode === MODES.noBooks) ? '环境' : '全量';
    // 找到备份来源：优先最新的目录备份，其次最新的镜像文件
    let src = null;
    try {
      const entries = fs.readdirSync(dest);
      // 目录备份：kindle_backup_*.img_备份目录
      const dirCandidates = entries
        .filter(n => /^kindle_backup_.*\.img_备份目录$/.test(n))
        .map(n => path.join(dest, n))
        .filter(p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (dirCandidates.length > 0) {
        src = dirCandidates[0];
        this.log('检测到目录备份: ' + src);
      } else {
        // 镜像文件：kindle_backup_*.img
        const imgCandidates = entries
          .filter(n => /^kindle_backup_.*\.img$/.test(n))
          .map(n => path.join(dest, n))
          .filter(p => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } })
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        if (imgCandidates.length > 0) {
          src = imgCandidates[0];
          this.log('检测到镜像备份: ' + src);
        }
      }
    } catch (e) {}

    if (!src) {
      this.finish(false, '在 ' + dest + ' 下没有找到「环境/全量」备份（目录或镜像）');
      return;
    }

    if (src.endsWith('.img')) {
      // 镜像文件：仅 macOS 支持挂载还原
      if (!this.isMac) {
        this.finish(false, '检测到的是 macOS 镜像备份，请在 macOS 版本中还原；如需跨平台还原，请使用目录方式重新备份');
        return;
      }
      this.log('还原镜像备份（macOS）...');
      await this.macImageRestore(src, kindle, label);
      return;
    }

    // 目录备份：跨平台通用，把目录内容原样写回 Kindle 根目录
    this.log('▶ 还原' + label + '备份（目录方式）开始');
    // 还原时排除目标里可能夹带的系统元数据
    await this.copyDir(src, kindle, { onFile: (done, total) => {
      this.progress(Math.min(done / Math.max(total, 1), 0.99), `还原${label}：已处理 ${done}/${total} 个文件`);
    }});
    this.progress(1.0, '完成');
    this.finish(true, label + '还原成功');
  }

  // macOS 镜像还原：挂载镜像 → 复制回 Kindle
  macImageRestore(imgPath, kindle, label) {
    return new Promise((resolve) => {
      const mountPoint = '/Volumes/KindleBackupRestore-' + Date.now();
      this.log('挂载镜像: ' + imgPath);
      execFile('/usr/bin/hdiutil', ['attach', '-mountpoint', mountPoint, '-nobrowse', '-readonly', imgPath],
        { env: { ...process.env, LC_ALL: 'C' } }, (err) => {
          if (err) {
            this.finish(false, '挂载镜像失败: ' + err.message);
            resolve();
            return;
          }
          setTimeout(async () => {
            try {
              await this.copyDir(mountPoint, kindle, { onFile: (done, total) => {
                this.progress(Math.min(done / Math.max(total, 1), 0.99), `还原${label}：已处理 ${done}/${total} 个文件`);
              }});
              this.progress(1.0, '完成');
              this.finish(true, label + '还原成功');
            } finally {
              execFile('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { env: { ...process.env, LC_ALL: 'C' } }, () => {});
            }
            resolve();
          }, 1000);
        });
    });
  }

  // 生成带日期的备份文件名，避免覆盖旧备份
  _backupStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  // ===== 入口 =====
  async startBackup(mode, dest) {
    this.cancelled = false;
    if (mode === MODES.booksOnly) {
      await this.backupBooks(dest);
    } else {
      // 环境备份 / 全量备份
      const imgPath = path.join(dest, 'kindle_backup_' + this._backupStamp() + '.img');
      const excludeBooks = (mode === MODES.noBooks);
      await this.backupToImage(imgPath, excludeBooks);
      if (mode === MODES.full && !this.cancelled) {
        await this.backupBooks(dest);
      }
    }
  }
}

module.exports = { BackupEngine, MODES, BOOK_EXTS };
