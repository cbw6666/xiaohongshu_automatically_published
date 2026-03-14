// ===================== IndexedDB 图片存储 =====================
const DB_NAME = 'xhsImageStore';
const DB_VERSION = 1;
const STORE_NAME = 'images';

function openImageDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveImageToDB(noteIndex, imgIndex, blob) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ id: `${noteIndex}_${imgIndex}`, noteIndex, imgIndex, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getImageFromDB(noteIndex, imgIndex) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(`${noteIndex}_${imgIndex}`);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteNoteImagesFromDB(noteIndex) {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value.noteIndex === noteIndex) {
          cursor.delete();
        }
        cursor.continue();
      } else {
        resolve();
      }
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAllImagesFromDB() {
  const db = await openImageDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllImagesForNote(noteIndex, imageCount) {
  const blobs = [];
  for (let i = 0; i < imageCount; i++) {
    const blob = await getImageFromDB(noteIndex, i);
    if (blob) blobs.push(blob);
  }
  return blobs;
}

// ===================== 状态变量 =====================
let notes = []; // 瘦身结构: { title, body, tags, productId, imageCount }
let isPublishing = false;
let currentPublishMode = 'immediate'; // 'immediate' | 'scheduled'

const publishConfig = {
  intervalType: 'fixed',
  fixedInterval: 300,
  minInterval: 300,
  maxInterval: 600,
};

// ===================== 日志函数 =====================
function addLog(message, type = 'info', details = '') {
  const logData = {
    time: new Date().toLocaleTimeString(),
    message,
    type,
    details
  };

  chrome.storage.local.get('logs', (data) => {
    const logs = data.logs || [];
    logs.push(logData);
    if (logs.length > 100) logs.shift();
    chrome.storage.local.set({ logs });
  });

  const logPanel = document.getElementById('logPanel');
  if (!logPanel) return;
  
  const logItem = document.createElement('div');
  logItem.className = `log-item ${type}`;
  
  const timeSpan = document.createElement('span');
  timeSpan.className = 'log-time';
  timeSpan.textContent = `[${logData.time}] `;
  
  const messageSpan = document.createElement('span');
  messageSpan.className = 'log-message';
  messageSpan.textContent = message;
  
  logItem.appendChild(timeSpan);
  logItem.appendChild(messageSpan);
  
  if (details) {
    const detailsDiv = document.createElement('div');
    detailsDiv.className = 'log-details';
    detailsDiv.textContent = details;
    logItem.appendChild(detailsDiv);
  }
  
  logPanel.appendChild(logItem);
  logPanel.scrollTop = logPanel.scrollHeight;
}

// ===================== DOMContentLoaded =====================
document.addEventListener('DOMContentLoaded', async () => {
  // ---- 模式切换 ----
  const modeTabs = document.querySelectorAll('.mode-tab');
  const modeContents = {
    immediate: document.getElementById('immediateSettings'),
    scheduled: document.getElementById('scheduledSettings')
  };

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentPublishMode = tab.dataset.mode;
      Object.values(modeContents).forEach(c => c.classList.remove('active'));
      modeContents[currentPublishMode].classList.add('active');
    });
  });

  // ---- 间隔类型切换(立即发布) ----
  setupIntervalToggle(
    'input[name="intervalType"]',
    '#intervalTypeGroup',
    '.fixed-interval',
    '.random-interval'
  );

  // ---- 间隔类型切换(定时发布) ----
  setupIntervalToggle(
    'input[name="schedIntervalType"]',
    '#schedIntervalTypeGroup',
    '.sched-fixed-interval',
    '.sched-random-interval'
  );

  function setupIntervalToggle(radioSelector, groupSelector, fixedSelector, randomSelector) {
    const radios = document.querySelectorAll(radioSelector);
    const group = document.querySelector(groupSelector);
    const fixedDiv = document.querySelector(fixedSelector);
    const randomDiv = document.querySelector(randomSelector);
    
    radios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        group.querySelectorAll('label').forEach(l => l.classList.remove('active'));
        e.target.parentElement.classList.add('active');
        if (e.target.value === 'fixed') {
          fixedDiv.style.display = '';
          randomDiv.style.display = 'none';
        } else {
          fixedDiv.style.display = 'none';
          randomDiv.style.display = '';
        }
      });
    });
  }

  // ---- 文件选择 ----
  const fileInput = document.getElementById('fileInput');
  const readFileBtn = document.getElementById('readFile');

  if (readFileBtn && fileInput) {
    readFileBtn.addEventListener('click', () => fileInput.click());
  }

  if (fileInput) {
    fileInput.addEventListener('change', handleFileSelect);
  }

  // ---- 开始运行 ----
  const startButton = document.getElementById('startButton');
  if (startButton) {
    startButton.onclick = handleStartPublish;
  }

  // ---- 终止程序 ----
  const clearAllButton = document.getElementById('clearAllButton');
  if (clearAllButton) {
    clearAllButton.onclick = handleClearAll;
  }

  // ---- 关闭 / 帮助 ----
  const closeBtn = document.querySelector('.close-btn');
  if (closeBtn) closeBtn.addEventListener('click', () => window.close());

  const helpBtn = document.querySelector('.help-btn');
  if (helpBtn) helpBtn.onclick = () => window.open('help.html', '_blank');

  // ---- 消息监听 ----
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'NOTE_PUBLISHED':
        addLog(`第${message.data.index + 1}篇笔记发布完成`, 'success');
        break;
      case 'WAITING':
        const wm = Math.floor(message.data.waitTime / 60);
        const ws = message.data.waitTime % 60;
        addLog(`等待发布第${message.data.nextIndex + 1}篇笔记...`, 'info', `等待时间: ${wm}分${ws}秒`);
        break;
      case 'ERROR':
        addLog(`发布出错: ${message.data}`, 'error');
        isPublishing = false;
        break;
      case 'COMPLETED':
        addLog('所有笔记发布完成', 'success');
        isPublishing = false;
        break;
      case 'STOPPED':
        addLog('已停止发布', 'info');
        isPublishing = false;
        break;
      case 'STATUS_UPDATE':
        if (!message.data.state.countdown) {
          addLog(message.data.message);
        }
        updateStatusDisplay(message.data.state);
        break;
      case 'DAILY_PUBLISH_START':
        addLog(`定时发布启动: 今日第${message.data.day}天，从第${message.data.startRow}行开始`, 'success');
        break;
      case 'DAILY_PUBLISH_DONE':
        addLog(`今日定时发布完成，共发布${message.data.count}篇`, 'success');
        break;
    }
  });

  // ---- 恢复定时发布状态 ----
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GET_SCHEDULE_STATE' });
    if (resp && resp.isScheduled) {
      currentPublishMode = 'scheduled';
      modeTabs.forEach(t => {
        t.classList.toggle('active', t.dataset.mode === 'scheduled');
      });
      Object.values(modeContents).forEach(c => c.classList.remove('active'));
      modeContents.scheduled.classList.add('active');
      
      const statusEl = document.getElementById('scheduleStatus');
      statusEl.textContent = `定时发布已启动 | 下次: ${resp.nextRun || '等待中'}`;
      statusEl.classList.add('active');
    }
  } catch (e) {}

  // ---- 检查是否正在发布 ----
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (state && state.isPublishing) {
      isPublishing = true;
      addLog('发布任务正在进行中...', 'info');
      startStatusUpdates();
    }
  } catch (e) {}

  addLog('插件已就绪', 'success');
});

// ===================== 文件选择处理 =====================
async function handleFileSelect() {
  const fileInput = document.getElementById('fileInput');
  if (fileInput.files.length === 0) return;
  const file = fileInput.files[0];

  addLog(`开始读取文件: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`, 'info');

  try {
    const fileName = file.name.toLowerCase();
    const isExcelFile = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
    const isCsvFile = fileName.endsWith('.csv');

    if (isExcelFile) {
      await handleExcelFile(file, fileName);
    } else if (isCsvFile) {
      const text = await file.text();
      addLog('检测到CSV格式，开始解析...', 'info');
      notes = await parseCsvNotes(text);
      updateNotePanels();
      addLog(`成功导入 ${notes.length} 篇笔记（CSV）`, 'success');
    } else {
      const text = await file.text();
      addLog('检测到TXT格式，开始解析...', 'info');
      const noteContents = text.split(/\-{5,}/).map(c => c.trim()).filter(Boolean);
      notes = noteContents.map(content => {
        const nd = parseNoteContent(content);
        return { ...nd, imageCount: 0 };
      });
      updateNotePanels();
      addLog(`成功导入 ${notes.length} 篇笔记（TXT）`, 'success');
    }
  } catch (error) {
    addLog(`读取文件失败: ${error.message}`, 'error');
  }
}

// ===================== Excel 处理 (IndexedDB版) =====================
async function handleExcelFile(file, fileName) {
  addLog('检测到Excel文件，正在解析...', 'info');

  if (typeof XLSX === 'undefined') {
    addLog('SheetJS 库未加载', 'error');
    return;
  }

  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

  if (jsonData.length < 2) {
    addLog('Excel 至少需要标题行和一行数据', 'error');
    return;
  }

  const header = jsonData[0].map(h => (h || '').toString().trim());
  addLog(`表头: ${header.join(', ')}`, 'info');

  const idx = {
    image: header.findIndex(h => h.includes('主图') || h.includes('封面')),
    productId: header.findIndex(h => h.includes('商品ID') || h.includes('商品id')),
    title: header.findIndex(h => h.includes('标题')),
    body: header.findIndex(h => h.includes('正文')),
    tags: header.findIndex(h => h.includes('标签'))
  };

  const innerImageCols = [];
  header.forEach((h, colIdx) => {
    if (/内页/.test(h)) innerImageCols.push(colIdx);
  });
  innerImageCols.sort((a, b) => a - b);

  if (idx.title === -1) {
    addLog('Excel 缺少"标题"列', 'error');
    return;
  }

  // 提取嵌入图片
  let embeddedImages = {};
  if (typeof JSZip !== 'undefined' && fileName.endsWith('.xlsx')) {
    addLog('使用 JSZip 提取嵌入图片...', 'info');
    try {
      const zip = await JSZip.loadAsync(arrayBuffer);
      embeddedImages = await extractExcelImages(zip);
    } catch (e) {
      addLog(`JSZip 解析失败: ${e.message}`, 'warning');
    }
  }

  // 清除旧的 IndexedDB 图片
  await clearAllImagesFromDB();

  const notesArr = [];
  for (let i = 1; i < jsonData.length; i++) {
    const row = jsonData[i];
    if (!row || row.length === 0) continue;

    const getVal = (index) => index >= 0 && index < row.length ? (row[index] || '').toString().trim() : '';
    const title = getVal(idx.title);
    if (!title) continue;

    const body = getVal(idx.body);
    let tags = [];
    const tagsStr = getVal(idx.tags);
    if (tagsStr) {
      tags = tagsStr.split(/[#\s,，]+/).filter(Boolean).map(t => '#' + t.replace(/^#/, ''));
    }
    const productId = getVal(idx.productId);

    const noteIndex = notesArr.length;
    let imageCount = 0;

    // 嵌入图片 → 直接存 IndexedDB（跳过 base64 中转）
    const rowEmbeddedImages = embeddedImages[i] || [];
    if (rowEmbeddedImages.length > 0) {
      for (let j = 0; j < rowEmbeddedImages.length; j++) {
        try {
          const dataUrl = rowEmbeddedImages[j];
          const byteString = atob(dataUrl.split(',')[1]);
          const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
          const ab = new ArrayBuffer(byteString.length);
          const ia = new Uint8Array(ab);
          for (let k = 0; k < byteString.length; k++) {
            ia[k] = byteString.charCodeAt(k);
          }
          const blob = new Blob([ab], { type: mimeString });
          await saveImageToDB(noteIndex, imageCount, blob);
          imageCount++;
        } catch (e) {
          addLog(`嵌入图片转换失败: ${e.message}`, 'warning');
        }
      }
      addLog(`第${i + 1}行: ${imageCount}张嵌入图片已存入IDB`, 'success');
    }

    // 如果没有嵌入图片，从链接下载
    if (imageCount === 0) {
      const allImageCols = [];
      if (idx.image >= 0) allImageCols.push(idx.image);
      allImageCols.push(...innerImageCols);

      for (const colIdx of allImageCols) {
        const cellValue = getVal(colIdx);
        if (!cellValue) continue;
        const imageLinks = cellValue
          .split(/[\n\r,，]/)
          .map(s => s.trim())
          .filter(s => s && (s.startsWith('http://') || s.startsWith('https://')))
          .map(s => s.replace(/[""]/g, ''));

        for (const link of imageLinks) {
          try {
            const res = await fetch(link);
            const blob = await res.blob();
            await saveImageToDB(noteIndex, imageCount, blob);
            imageCount++;
          } catch (e) {
            addLog(`图片下载失败: ${link}`, 'error');
          }
        }
      }
    }

    notesArr.push({ title, body, tags, productId, imageCount });
    addLog(`第${i + 1}行: ${title} (${imageCount}张图)`, 'info');
  }

  notes = notesArr;
  updateNotePanels();
  const totalImages = notes.reduce((s, n) => s + n.imageCount, 0);
  addLog(`成功导入 ${notes.length} 篇笔记，共 ${totalImages} 张图片（已存入IndexedDB）`, 'success');
}

// ===================== CSV 解析 (IndexedDB版) =====================
async function parseCsvNotes(csvText) {
  const lines = parseCsvWithNewlines(csvText);
  if (lines.length < 2) {
    addLog('CSV至少需要标题行和一行数据', 'error');
    return [];
  }

  const header = parseCsvLine(lines[0]);
  const idx = {
    image: header.findIndex(h => h.includes('主图') || h.includes('封面')),
    productId: header.findIndex(h => h.includes('商品ID') || h.includes('商品id')),
    title: header.findIndex(h => h.includes('标题')),
    body: header.findIndex(h => h.includes('正文')),
    tags: header.findIndex(h => h.includes('标签'))
  };

  const innerImageCols = [];
  header.forEach((h, colIdx) => {
    if (/内页/.test(h)) innerImageCols.push(colIdx);
  });
  innerImageCols.sort((a, b) => a - b);

  if (idx.title === -1) {
    addLog('CSV缺少"标题"字段', 'error');
    return [];
  }

  await clearAllImagesFromDB();
  const notesArr = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const row = parseCsvLine(lines[i]);
      if (row.length < 2) continue;

      const getVal = (index) => index >= 0 && index < row.length ? row[index] : '';
      let tags = [];
      if (idx.tags >= 0 && idx.tags < row.length && row[idx.tags]) {
        tags = row[idx.tags].split(/[#\s,，]+/).filter(Boolean).map(t => '#' + t.replace(/^#/, ''));
      }

      const noteIndex = notesArr.length;
      let imageCount = 0;

      // 图片链接
      const allImageCols = [];
      if (idx.image >= 0) allImageCols.push(idx.image);
      allImageCols.push(...innerImageCols);

      for (const colIdx of allImageCols) {
        if (colIdx >= 0 && colIdx < row.length && row[colIdx]) {
          const links = row[colIdx]
            .split(/[\n\r,，]/)
            .map(s => s.trim())
            .filter(s => s && (s.startsWith('http://') || s.startsWith('https://')))
            .map(s => s.replace(/[""]/g, ''));
          for (const link of links) {
            try {
              const res = await fetch(link);
              const blob = await res.blob();
              await saveImageToDB(noteIndex, imageCount, blob);
              imageCount++;
            } catch (e) {
              addLog(`图片下载失败: ${link}`, 'error');
            }
          }
        }
      }

      notesArr.push({
        title: getVal(idx.title),
        body: getVal(idx.body),
        tags,
        productId: getVal(idx.productId),
        imageCount
      });
    } catch (e) {
      addLog(`解析第${i + 1}行失败: ${e.message}`, 'error');
    }
  }

  return notesArr;
}

// ===================== 开始发布 =====================
async function handleStartPublish() {
  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => resolve(r || { isPublishing: false }));
    });

    if (response.isPublishing) {
      addLog('正在发布中，请等待...', 'info');
      return;
    }

    if (notes.length === 0) {
      addLog('请先导入笔记文件', 'error');
      return;
    }

    if (currentPublishMode === 'immediate') {
      await startImmediatePublish();
    } else {
      await startScheduledPublish();
    }
  } catch (error) {
    addLog(`启动失败: ${error.message}`, 'error');
  }
}

async function startImmediatePublish() {
  const startRow = parseInt(document.getElementById('startRow').value) || 1;
  let publishCount = parseInt(document.getElementById('publishCount').value) || 0;
  const intervalType = document.querySelector('input[name="intervalType"]:checked').value;
  const fixedInterval = parseInt(document.getElementById('fixedInterval').value) * 60;
  const minInterval = parseInt(document.getElementById('minInterval').value) * 60;
  const maxInterval = parseInt(document.getElementById('maxInterval').value) * 60;

  const startIndex = startRow - 1;
  if (startIndex >= notes.length) {
    addLog(`起始行 ${startRow} 超出笔记总数 ${notes.length}`, 'error');
    return;
  }

  const available = notes.length - startIndex;
  const count = (publishCount > 0 && publishCount < available) ? publishCount : available;

  // 检查图片
  for (let i = startIndex; i < startIndex + count; i++) {
    if (!notes[i].title || notes[i].imageCount === 0) {
      addLog(`第${i + 1}篇笔记缺少标题或图片`, 'error');
      return;
    }
  }

  addLog(`立即发布: 从第${startRow}行开始，共${count}篇`, 'info');

  const publishResponse = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'START_PUBLISH',
      data: {
        startIndex,
        count,
        publishConfig: { intervalType, fixedInterval, minInterval, maxInterval }
      }
    }, (r) => resolve(r));
  });

  if (publishResponse && publishResponse.error) {
    addLog(publishResponse.error, 'error');
    return;
  }

  isPublishing = true;
  addLog('开始发布笔记...', 'info');
  startStatusUpdates();
}

async function startScheduledPublish() {
  const dailyStartTime = document.getElementById('dailyStartTime').value;
  const dailyCount = parseInt(document.getElementById('dailyCount').value) || 5;
  const startRow = parseInt(document.getElementById('schedStartRow').value) || 1;
  const intervalType = document.querySelector('input[name="schedIntervalType"]:checked').value;
  const fixedInterval = parseInt(document.getElementById('schedFixedInterval').value) * 60;
  const minInterval = parseInt(document.getElementById('schedMinInterval').value) * 60;
  const maxInterval = parseInt(document.getElementById('schedMaxInterval').value) * 60;

  addLog(`定时发布设置: 每天${dailyStartTime}启动，每天${dailyCount}篇，从第${startRow}行开始`, 'info');

  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'TOGGLE_SCHEDULE',
      data: {
        enabled: true,
        dailyStartTime,
        dailyCount,
        startRow,
        publishConfig: { intervalType, fixedInterval, minInterval, maxInterval }
      }
    }, (r) => resolve(r));
  });

  if (resp && resp.success) {
    const statusEl = document.getElementById('scheduleStatus');
    statusEl.textContent = `定时发布已启动 | 每天 ${dailyStartTime} 开始，每天 ${dailyCount} 篇`;
    statusEl.classList.add('active');
    addLog('定时发布已启动', 'success');
  } else {
    addLog('定时发布启动失败', 'error');
  }
}

// ===================== 终止程序 =====================
async function handleClearAll() {
  if (!confirm('确定要终止并清空所有内容吗？此操作不可恢复！')) return;

  try {
    await chrome.runtime.sendMessage({ type: 'STOP_PUBLISH' });
  } catch (e) {}

  try {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_SCHEDULE', data: { enabled: false } });
  } catch (e) {}

  notes = [];
  isPublishing = false;
  await clearAllImagesFromDB();
  
  try {
    await chrome.storage.local.remove(['popupState', 'logs', 'pState', 'scheduleConfig']);
  } catch (e) {}

  updateNotePanels();
  const logPanel = document.getElementById('logPanel');
  if (logPanel) logPanel.innerHTML = '';

  const statusEl = document.getElementById('scheduleStatus');
  statusEl.classList.remove('active');

  addLog('已清空所有内容，请重新导入！', 'error');
}

// ===================== 笔记面板更新 =====================
function updateNotePanels() {
  const container = document.querySelector('.notes-container');
  if (!container) return;
  container.innerHTML = '';

  notes.forEach((note, index) => {
    const panel = document.createElement('div');
    panel.className = 'note-panel';
    panel.id = `note${index + 1}`;

    panel.innerHTML = `
      <div class="note-header">
        <span class="note-title">第${index + 1}篇 | ${note.imageCount}张图</span>
        <div class="note-actions">
          <button class="icon-btn select-image" title="添加图片">
            <svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg>
          </button>
          <button class="icon-btn clear-images" title="清空图片">
            <svg class="svg-icon" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M5 6v14a1 1 0 001 1h12a1 1 0 001-1V6"/></svg>
          </button>
          <button class="icon-btn delete-note" title="删除笔记" style="color:#F85149;">
            <svg class="svg-icon" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <input type="file" class="image-input" accept="image/*" multiple style="display:none;">
      <div class="image-preview"></div>
      <div class="preview">
        <div class="preview-item">
          <label>标题</label>
          <input type="text" class="title-input" value="${escapeHtml(note.title)}">
        </div>
        <div class="preview-item">
          <label>正文</label>
          <textarea class="body-input">${escapeHtml(note.body)}</textarea>
        </div>
        <div class="preview-item">
          <label>标签</label>
          <input type="text" class="tags-input" value="${escapeHtml(note.tags.join(' '))}">
        </div>
        <div class="preview-item">
          <label>商品ID</label>
          <input type="text" class="product-id" value="${escapeHtml(note.productId || '')}">
        </div>
      </div>
    `;

    // 绑定编辑事件（修改后同步元数据）
    panel.querySelector('.title-input').addEventListener('change', (e) => {
      notes[index].title = e.target.value.trim();
      syncNotesMeta();
    });
    panel.querySelector('.body-input').addEventListener('change', (e) => {
      notes[index].body = e.target.value.trim();
      syncNotesMeta();
    });
    panel.querySelector('.tags-input').addEventListener('change', (e) => {
      notes[index].tags = e.target.value.trim().split(/\s+/).filter(t => t.startsWith('#'));
      syncNotesMeta();
    });
    panel.querySelector('.product-id').addEventListener('change', (e) => {
      notes[index].productId = e.target.value.trim();
      syncNotesMeta();
    });

    // 图片操作
    const imageInput = panel.querySelector('.image-input');
    panel.querySelector('.select-image').onclick = () => imageInput.click();

    imageInput.onchange = async function () {
      if (this.files.length === 0) return;
      const files = Array.from(this.files);
      let count = note.imageCount;
      for (const f of files) {
        await saveImageToDB(index, count, f);
        count++;
      }
      notes[index].imageCount = count;
      panel.querySelector('.note-title').textContent = `第${index + 1}篇 | ${count}张图`;
      addLog(`第${index + 1}篇添加了${files.length}张图片`, 'success');
      syncNotesMeta();
      await loadImagePreviews(panel, index);
    };

    panel.querySelector('.clear-images').onclick = async () => {
      await deleteNoteImagesFromDB(index);
      notes[index].imageCount = 0;
      panel.querySelector('.note-title').textContent = `第${index + 1}篇 | 0张图`;
      panel.querySelector('.image-preview').innerHTML = '';
      syncNotesMeta();
      addLog(`已清空第${index + 1}篇的图片`);
    };

    panel.querySelector('.delete-note').onclick = async () => {
      if (!confirm(`确定删除第${index + 1}篇笔记？`)) return;
      await deleteNoteImagesFromDB(index);
      notes.splice(index, 1);
      updateNotePanels();
      addLog(`已删除第${index + 1}篇笔记`);
    };

    container.appendChild(panel);

    // 懒加载图片预览
    loadImagePreviews(panel, index);
  });

  // 同步笔记元数据到 storage，供 background.js 读取
  syncNotesMeta();
}

function syncNotesMeta() {
  const meta = notes.map(n => ({
    title: n.title,
    body: n.body,
    tags: n.tags,
    productId: n.productId,
    imageCount: n.imageCount
  }));
  chrome.storage.local.set({ notesMeta: meta });
}

// 懒加载图片预览 - 按需从 IDB 读取
async function loadImagePreviews(panel, noteIndex) {
  const previewContainer = panel.querySelector('.image-preview');
  previewContainer.innerHTML = '';

  const imageCount = notes[noteIndex].imageCount;
  for (let i = 0; i < imageCount; i++) {
    try {
      const blob = await getImageFromDB(noteIndex, i);
      if (!blob) continue;

      const url = URL.createObjectURL(blob);
      const img = document.createElement('img');
      img.src = url;
      img.title = `图${i + 1}`;
      img.onload = () => URL.revokeObjectURL(url); // 显示后立即释放
      previewContainer.appendChild(img);
    } catch (e) {
      // skip
    }
  }
}

// ===================== 状态更新 =====================
function startStatusUpdates() {
  if (window.statusUpdateTimer) clearInterval(window.statusUpdateTimer);

  window.statusUpdateTimer = setInterval(async () => {
    try {
      const state = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (r) => resolve(r || { isPublishing: false }));
      });

      if (!state.isPublishing) {
        clearInterval(window.statusUpdateTimer);
        window.statusUpdateTimer = null;
        isPublishing = false;
      }
    } catch (e) {}
  }, 5000);
}

function updateStatusDisplay(state) {
  const logPanel = document.getElementById('logPanel');
  if (!logPanel) return;

  if (state.countdown) {
    let statusDiv = logPanel.querySelector('.log-item.countdown');
    if (!statusDiv) {
      statusDiv = document.createElement('div');
      statusDiv.className = 'log-item countdown';
      logPanel.appendChild(statusDiv);
    }
    statusDiv.textContent = `发布 ${state.currentIndex + 1}/${state.totalNotes} | 倒计时: ${state.countdown.current}s`;
    logPanel.scrollTop = logPanel.scrollHeight;
  }
}

// ===================== 工具函数 =====================
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseNoteContent(text) {
  try {
    const lines = text.split('\n');
    const title = lines[0].trim();
    let body = [];
    let tags = [];
    let productId = '';
    let isBody = true;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.includes('#')) {
        isBody = false;
        const tagMatches = trimmed.match(/#[\u4e00-\u9fa5a-zA-Z0-9]+/g);
        if (tagMatches) tags = tags.concat(tagMatches);
        continue;
      }

      if (trimmed.toLowerCase().includes('商品id') || trimmed.includes('商品：') || trimmed.includes('商品:')) {
        isBody = false;
        const idMatch = trimmed.match(/(?:商品id|商品)[：:]\s*([a-zA-Z0-9]+)/i);
        if (idMatch) productId = idMatch[1].trim();
        continue;
      }

      if (isBody) body.push(line);
    }

    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
    while (body.length > 0 && body[0].trim() === '') body.shift();

    return { title, body: body.join('\n'), tags, productId };
  } catch (e) {
    return { title: '', body: '', tags: [], productId: '' };
  }
}

function parseCsvWithNewlines(csvText) {
  const lines = [];
  let currentLine = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = '';
    } else {
      currentLine += char;
    }
  }
  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines;
}

function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// ===================== Excel 嵌入图片提取 =====================
async function extractExcelImages(zip) {
  const imagesByRow = {};

  try {
    const mediaFiles = {};
    const mediaFolder = zip.folder('xl/media');
    if (!mediaFolder) return imagesByRow;

    const mediaEntries = [];
    mediaFolder.forEach((relativePath, file) => {
      if (!file.dir && /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(relativePath)) {
        mediaEntries.push({ path: 'xl/media/' + relativePath, file });
      }
    });

    if (mediaEntries.length === 0) return imagesByRow;

    addLog(`发现 ${mediaEntries.length} 张嵌入图片...`, 'info');

    await Promise.all(mediaEntries.map(async (entry) => {
      try {
        const uint8 = await entry.file.async('uint8array');
        const ext = entry.path.split('.').pop().toLowerCase();
        const mimeMap = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
          tif: 'image/tiff', tiff: 'image/tiff'
        };
        const mime = mimeMap[ext] || 'image/png';
        let binary = '';
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        mediaFiles[entry.path] = `data:${mime};base64,${btoa(binary)}`;
      } catch (e) {}
    }));

    // 解析 drawing rels
    const rIdToImage = {};
    const drawingRelsFiles = [];
    zip.forEach((path, file) => {
      if (/xl\/drawings\/_rels\/drawing\d*\.xml\.rels$/i.test(path)) {
        drawingRelsFiles.push({ path, file });
      }
    });

    for (const relsEntry of drawingRelsFiles) {
      try {
        const relsXml = await relsEntry.file.async('string');
        const doc = new DOMParser().parseFromString(relsXml, 'application/xml');
        doc.querySelectorAll('Relationship').forEach(rel => {
          const rId = rel.getAttribute('Id');
          const target = rel.getAttribute('Target');
          if (target && /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(target)) {
            let absPath = target;
            if (target.startsWith('../')) absPath = 'xl/' + target.replace('../', '');
            else if (!target.startsWith('xl/')) absPath = 'xl/drawings/' + target;
            rIdToImage[rId] = absPath;
          }
        });
      } catch (e) {}
    }

    // 解析 drawing XML
    const drawingFiles = [];
    zip.forEach((path, file) => {
      if (/xl\/drawings\/drawing\d*\.xml$/i.test(path) && !path.includes('_rels')) {
        drawingFiles.push({ path, file });
      }
    });

    for (const drawingEntry of drawingFiles) {
      try {
        const drawingXml = await drawingEntry.file.async('string');
        const doc = new DOMParser().parseFromString(drawingXml, 'application/xml');
        const anchors = doc.querySelectorAll('twoCellAnchor, oneCellAnchor, absoluteAnchor');

        anchors.forEach(anchor => {
          try {
            const fromRow = anchor.querySelector('from row');
            const fromCol = anchor.querySelector('from col');
            if (!fromRow) return;
            const rowIndex = parseInt(fromRow.textContent);
            const colIndex = fromCol ? parseInt(fromCol.textContent) : 999;

            const blip = anchor.querySelector('blip');
            if (!blip) return;
            const rId = blip.getAttribute('r:embed') ||
              blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
            if (!rId) return;

            const imagePath = rIdToImage[rId];
            if (!imagePath) return;
            const dataUrl = mediaFiles[imagePath];
            if (!dataUrl) return;

            if (!imagesByRow[rowIndex]) imagesByRow[rowIndex] = [];
            imagesByRow[rowIndex].push({ dataUrl, colIndex });
          } catch (e) {}
        });
      } catch (e) {}
    }

    // 回退: 按顺序分配
    const totalMapped = Object.values(imagesByRow).reduce((s, a) => s + a.length, 0);
    if (totalMapped === 0 && Object.keys(mediaFiles).length > 0) {
      const allImages = Object.values(mediaFiles);
      allImages.forEach((dataUrl, idx) => {
        const row = idx + 1;
        if (!imagesByRow[row]) imagesByRow[row] = [];
        imagesByRow[row].push(dataUrl);
      });
    }

    // 排序并转回纯数组
    for (const row of Object.keys(imagesByRow)) {
      const imgs = imagesByRow[row];
      if (imgs.length > 0 && typeof imgs[0] === 'object' && imgs[0].colIndex !== undefined) {
        imgs.sort((a, b) => a.colIndex - b.colIndex);
        imagesByRow[row] = imgs.map(item => item.dataUrl);
      }
    }

  } catch (e) {
    addLog(`提取嵌入图片失败: ${e.message}`, 'error');
  }

  return imagesByRow;
}
