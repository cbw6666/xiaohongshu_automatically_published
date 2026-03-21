// ===================== IndexedDB 图片读取（Service Worker端）=====================
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

async function getAllImagesForNote(noteIndex, imageCount) {
  const blobs = [];
  for (let i = 0; i < imageCount; i++) {
    const blob = await getImageFromDB(noteIndex, i);
    if (blob) blobs.push(blob);
  }
  return blobs;
}

// Blob → base64 DataUrl（用于 scripting.executeScript 传参）
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ===================== 发布状态 =====================
let publishState = {
  isPublishing: false,
  currentIndex: 0,
  totalNotes: 0,
  publishConfig: null,
  tabId: null,
  currentAction: '',
  waitTime: 0
};

// ===================== 定时发布状态 =====================
let scheduleConfig = null; // { dailyStartTime, dailyCount, startRow, publishConfig, currentNoteOffset }

// ===================== 侧边栏打开 =====================
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.error('打开侧边栏失败:', error);
    try {
      await chrome.action.setPopup({ popup: 'popup.html' });
    } catch (e) {}
  }
});

// ===================== 消息路由 =====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    switch (message.type) {
      case 'START_PUBLISH':
        await startPublishing(message.data);
        return { success: true };

      case 'GET_STATE':
        // Service Worker 重启后内存中 publishState 会丢失，从 storage 恢复
        if (!publishState.isPublishing) {
          const saved = await chrome.storage.local.get('publishProgress');
          if (saved.publishProgress && saved.publishProgress.isPublishing) {
            const p = saved.publishProgress;
            // 如果在等待中，计算剩余秒数
            let waitTime = 0;
            if (p.waitEndTime && p.waitEndTime > Date.now()) {
              waitTime = Math.ceil((p.waitEndTime - Date.now()) / 1000);
            }
            return {
              isPublishing: true,
              currentIndex: p.currentIndex,
              totalNotes: p.totalNotes,
              currentAction: p.currentAction || '等待发布下一篇...',
              waitTime
            };
          }
        }
        return publishState;

      case 'STOP_PUBLISH':
        await stopPublishing();
        return { success: true };

      case 'TOGGLE_SCHEDULE':
        return await toggleSchedule(message.data);

      case 'GET_SCHEDULE_STATE':
        return getScheduleState();
    }
  };

  handleMessage().then(response => {
    if (sendResponse) sendResponse(response);
  }).catch(error => {
    console.error('消息处理出错:', error);
    if (sendResponse) sendResponse({ error: error.message });
  });

  return true; // async
});

// ===================== 立即发布（启动入口） =====================
async function startPublishing(data) {
  if (publishState.isPublishing) return;

  // 从 storage 恢复笔记元数据（popup 存的）
  const notesData = await getNotesMeta();
  if (!notesData || notesData.length === 0) {
    notifyPopup('ERROR', '没有找到笔记数据，请先在面板导入');
    return;
  }

  const { startIndex, count, publishConfig } = data;
  const endIndex = Math.min(startIndex + count, notesData.length);

  publishState = {
    isPublishing: true,
    currentIndex: 0,
    totalNotes: endIndex - startIndex,
    publishConfig,
    tabId: null,
    currentAction: '准备发布',
    waitTime: 0
  };

  try {
    // 创建新标签页
    const tab = await chrome.tabs.create({
      url: 'https://creator.xiaohongshu.com/publish/publish',
      active: true
    });
    publishState.tabId = tab.id;

    // 把发布进度保存到 storage（Service Worker 被杀后可恢复）
    await chrome.storage.local.set({
      publishProgress: {
        isPublishing: true,
        startIndex,
        endIndex,
        currentNoteIndex: startIndex,  // 当前要发布的笔记在 notesData 中的索引
        currentIndex: 0,               // 已发布篇数
        totalNotes: endIndex - startIndex,
        publishConfig,
        tabId: tab.id,
        currentAction: '准备发布'
      }
    });

    // 发布第一篇（后续由 alarm 驱动）
    await publishCurrentNote();

  } catch (error) {
    console.error('启动发布失败:', error);
    notifyPopup('ERROR', error.message);
    await cleanup();
  }
}

// ===================== 逐篇发布（alarm 驱动核心） =====================
async function publishCurrentNote() {
  // 从 storage 读取进度
  const saved = await chrome.storage.local.get('publishProgress');
  const progress = saved.publishProgress;

  if (!progress || !progress.isPublishing) {
    await cleanup();
    return;
  }

  const notesData = await getNotesMeta();
  if (!notesData || notesData.length === 0) {
    notifyPopup('ERROR', '笔记数据丢失');
    await cleanup();
    return;
  }

  const i = progress.currentNoteIndex;

  // 恢复内存中的状态
  publishState.isPublishing = true;
  publishState.currentIndex = progress.currentIndex;
  publishState.totalNotes = progress.totalNotes;
  publishState.publishConfig = progress.publishConfig;
  publishState.tabId = progress.tabId;

  try {
    const note = notesData[i];
    // 从 IndexedDB 逐篇读取图片
    const blobs = await getAllImagesForNote(i, note.imageCount);
    // 转 base64 用于 content script
    const imageDataUrls = [];
    for (const blob of blobs) {
      imageDataUrls.push(await blobToDataUrl(blob));
    }

    await publishSingleNote(note, imageDataUrls, progress.tabId);

    // 发布成功，更新进度
    const newCurrentIndex = progress.currentIndex + 1;
    const nextNoteIndex = i + 1;

    publishState.currentIndex = newCurrentIndex;
    notifyPopup('NOTE_PUBLISHED', {
      index: i,
      current: newCurrentIndex,
      total: progress.totalNotes
    });

    // 检查是否全部发完
    if (nextNoteIndex >= progress.endIndex) {
      // 如果是定时发布模式，发送今日完成通知
      if (scheduleConfig) {
        chrome.runtime.sendMessage({
          type: 'DAILY_PUBLISH_DONE',
          data: { count: progress.totalNotes }
        }).catch(() => {});
      }
      notifyPopup('COMPLETED');
      await cleanup();
      return;
    }

    // 还有下一篇，设置 alarm 等待
    const waitTime = calculateWaitTime(progress.publishConfig);

    // 更新 storage 中的进度（指向下一篇）
    await chrome.storage.local.set({
      publishProgress: {
        ...progress,
        currentNoteIndex: nextNoteIndex,
        currentIndex: newCurrentIndex,
        currentAction: '等待发布下一篇',
        waitTime,
        waitStartTime: Date.now(),
        waitEndTime: Date.now() + waitTime * 1000
      }
    });

    publishState.waitTime = waitTime;
    publishState.currentAction = '等待发布下一篇';

    notifyPopup('WAITING', {
      nextIndex: nextNoteIndex,
      waitTime,
      current: newCurrentIndex,
      total: progress.totalNotes,
      currentTime: new Date().toLocaleTimeString()
    });

    // 用 chrome.alarms 等待，不用 setTimeout！
    // alarms 最小精度约 30 秒，delayInMinutes 小于 0.5 时 Chrome 会自动拉到约 30 秒
    const delayMinutes = Math.max(waitTime / 60, 0.5);
    await chrome.alarms.create('noteInterval', {
      delayInMinutes: delayMinutes
    });

    console.log(`下一篇将在 ${waitTime} 秒后发布（alarm 设 ${delayMinutes.toFixed(2)} 分钟）`);

  } catch (error) {
    console.error('发布笔记失败:', error);
    notifyPopup('ERROR', error.message);
    await cleanup();
  }
}

// ===================== 定时发布调度 =====================
async function toggleSchedule(data) {
  if (!data.enabled) {
    // 关闭定时
    await chrome.alarms.clear('dailyPublish');
    scheduleConfig = null;
    await chrome.storage.local.remove('scheduleConfig');
    return { success: true };
  }

  // 启用定时
  scheduleConfig = {
    dailyStartTime: data.dailyStartTime,
    dailyCount: data.dailyCount,
    startRow: data.startRow,
    publishConfig: data.publishConfig,
    currentNoteOffset: 0  // 累计已发布篇数（替代 currentDayOffset，避免跳篇）
  };

  await chrome.storage.local.set({ scheduleConfig });
  await setDailyAlarm(data.dailyStartTime);

  return { success: true };
}

async function setDailyAlarm(timeStr) {
  // timeStr = "HH:MM"
  const [hours, minutes] = timeStr.split(':').map(Number);
  const now = new Date();
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);

  // 如果今天已过，设为明天
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  const delayMinutes = (target.getTime() - now.getTime()) / 60000;
  
  await chrome.alarms.create('dailyPublish', {
    delayInMinutes: delayMinutes,
    periodInMinutes: 24 * 60 // 每24小时重复
  });

  console.log(`定时发布 alarm 已设置，下次触发: ${target.toLocaleString()}`);
}

function getScheduleState() {
  if (!scheduleConfig) return { isScheduled: false };
  return {
    isScheduled: true,
    dailyStartTime: scheduleConfig.dailyStartTime,
    dailyCount: scheduleConfig.dailyCount,
    nextRun: scheduleConfig.dailyStartTime
  };
}

// ===================== Alarm 统一监听 =====================
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'noteInterval') {
    // 篇间等待结束，发布下一篇
    console.log('篇间等待 alarm 触发，开始发布下一篇');
    await publishCurrentNote();
    return;
  }

  if (alarm.name === 'dailyPublish') {
    // 从 storage 恢复 scheduleConfig
    if (!scheduleConfig) {
      const data = await chrome.storage.local.get('scheduleConfig');
      scheduleConfig = data.scheduleConfig;
    }
    if (!scheduleConfig) return;
    await handleDailyStart();
    return;
  }

  if (alarm.name === 'dailyPublishDelayed') {
    // 随机延迟结束，真正开始今日发布
    console.log('随机延迟 alarm 触发，开始执行今日定时发布');
    await executeDailyPublish();
    return;
  }
});

async function handleDailyStart() {
  if (publishState.isPublishing) {
    console.log('跳过定时发布：当前有任务在执行');
    return;
  }

  // 用 alarm 实现随机启动延迟（替代不可靠的 setTimeout）
  const delayMinutes = randomInt(0, 45); // 0~45 分钟
  console.log(`定时触发，随机等待 ${delayMinutes} 分钟后开始发布`);

  if (delayMinutes > 0) {
    // 创建一个延迟 alarm，到时间再真正开始
    await chrome.alarms.create('dailyPublishDelayed', {
      delayInMinutes: Math.max(delayMinutes, 0.5) // alarm 最小精度约 30 秒
    });
    return; // 等 alarm 触发后执行 executeDailyPublish
  }

  // 延迟为 0，直接执行
  await executeDailyPublish();
}

async function executeDailyPublish() {
  // 二次检查（延迟期间可能手动启动了）
  if (publishState.isPublishing) {
    console.log('跳过定时发布：已有任务在执行');
    return;
  }

  // 从 storage 恢复 scheduleConfig（Service Worker 可能重启过）
  if (!scheduleConfig) {
    const data = await chrome.storage.local.get('scheduleConfig');
    scheduleConfig = data.scheduleConfig;
  }
  if (!scheduleConfig) return;

  const notesData = await getNotesMeta();
  if (!notesData || notesData.length === 0) return;

  // 用累计已发布篇数计算起始位置（修复跳篇问题）
  const startIndex = (scheduleConfig.startRow - 1) + (scheduleConfig.currentNoteOffset || 0);

  // 每天发布篇数随机波动 70%~100%
  const baseCount = scheduleConfig.dailyCount;
  const count = Math.min(
    Math.max(Math.floor(baseCount * (0.7 + Math.random() * 0.3)), 1),
    notesData.length - startIndex
  );

  if (count <= 0) {
    console.log('所有笔记已发布完毕');
    notifyPopup('COMPLETED');
    return;
  }

  console.log(`今天计划发布 ${count} 篇（基础设置 ${baseCount} 篇），从第 ${startIndex + 1} 篇开始`);

  // 通知 popup
  chrome.runtime.sendMessage({
    type: 'DAILY_PUBLISH_START',
    data: { day: Math.floor((scheduleConfig.currentNoteOffset || 0) / baseCount) + 1, startRow: startIndex + 1 }
  }).catch(() => {});

  // 按实际篇数递增偏移（修复跳篇：用实际 count 而非固定 dailyCount）
  scheduleConfig.currentNoteOffset = (scheduleConfig.currentNoteOffset || 0) + count;
  await chrome.storage.local.set({ scheduleConfig });

  // 启动发布（DAILY_PUBLISH_DONE 通知已移至 publishCurrentNote 中全部完成时发送）
  await startPublishing({
    startIndex,
    count,
    publishConfig: scheduleConfig.publishConfig
  });
}

// ===================== 发布单篇笔记（反检测优化版） =====================
async function publishSingleNote(noteData, imageDataUrls, tabId) {
  publishState.currentAction = '打开发布页面';
  notifyPopup('ACTION_UPDATE');

  await chrome.tabs.update(tabId, {
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch'
  });

  // 模块2：随机等待页面加载 4~12秒
  publishState.currentAction = '等待页面加载';
  await randomDelay(4000, 12000);

  // 模块4：模拟真人浏览行为（随机滚动）
  publishState.currentAction = '浏览页面';
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const scrollTimes = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < scrollTimes; i++) {
        const scrollY = Math.floor(Math.random() * 300);
        window.scrollBy({ top: scrollY, behavior: 'smooth' });
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
      await new Promise(r => setTimeout(r, 300 + Math.random() * 700));
    }
  });
  await randomDelay(500, 1500);

  // 点击图文按钮（模块3：完整鼠标事件链）
  publishState.currentAction = '点击图文按钮';
  const clickResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      function simulateClick(element) {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
        const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        element.dispatchEvent(new MouseEvent('mouseover', opts));
        element.dispatchEvent(new MouseEvent('mouseenter', opts));
        element.dispatchEvent(new MouseEvent('mousemove', opts));
        element.dispatchEvent(new MouseEvent('mousedown', opts));
        element.dispatchEvent(new MouseEvent('mouseup', opts));
        element.dispatchEvent(new MouseEvent('click', opts));
      }

      return new Promise((resolve) => {
        const selectors = [
          '#web > div > div > div > div.header > div.header-tabs > div:nth-child(3) > span',
          '#web > div.outarea.upload-c > div > div > div.header > div:nth-child(2) > span',
          '#web > div > div > div > div.header > div:nth-child(2) > span',
          '.header-tabs > div:nth-child(3) > span'
        ];

        let found = false;
        const timer = setInterval(() => {
          for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn) {
              clearInterval(timer);
              simulateClick(btn);
              found = true;
              resolve({ success: true });
              return;
            }
          }
          const spans = document.querySelectorAll('span');
          const btn = Array.from(spans).find(s => s.textContent.includes('图文'));
          if (btn) {
            clearInterval(timer);
            simulateClick(btn);
            found = true;
            resolve({ success: true });
          }
        }, 1000);

        setTimeout(() => {
          if (!found) {
            clearInterval(timer);
            resolve({ success: false, error: '未找到图文按钮' });
          }
        }, 20000);
      });
    }
  });

  if (!clickResult[0].result.success) {
    throw new Error(clickResult[0].result.error || '未找到图文按钮');
  }

  // 模块2：随机等待 3~10秒
  await randomDelay(3000, 10000);

  // 上传图片
  publishState.currentAction = '上传图片';
  notifyPopup('ACTION_UPDATE');

  const uploadResult = await chrome.scripting.executeScript({
    target: { tabId },
    func: (imageDataArray) => {
      return new Promise((resolve) => {
        const selectors = [
          '#web > div > div > div > div.upload-content.hasBannerHeight > div.upload-wrapper > div > input',
          '#web > div > div > div > div.upload-content > div.upload-wrapper > div > input',
          '#web > div.outarea.upload-c > div > div > div.upload-content > div.upload-wrapper > div > input',
          '.upload-input[type="file"]',
          'input[type="file"][multiple][accept*=".jpg"]',
          'input[type="file"][accept*="image"]'
        ];

        let uploadInput = null;
        for (const sel of selectors) {
          uploadInput = document.querySelector(sel);
          if (uploadInput) break;
        }

        if (!uploadInput) {
          resolve({ success: false, error: '未找到上传输入框' });
          return;
        }

        const dataTransfer = new DataTransfer();
        imageDataArray.forEach((imgData, idx) => {
          const byteString = atob(imgData.split(',')[1]);
          const mimeString = imgData.split(',')[0].split(':')[1].split(';')[0];
          const ab = new ArrayBuffer(byteString.length);
          const ia = new Uint8Array(ab);
          for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
          const blob = new Blob([ab], { type: mimeString });
          const ext = mimeString.includes('png') ? 'png' : 'jpg';
          dataTransfer.items.add(new File([blob], `image${idx + 1}.${ext}`, { type: mimeString }));
        });

        uploadInput.files = dataTransfer.files;
        uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
        resolve({ success: true });
      });
    },
    args: [imageDataUrls]
  });

  if (!uploadResult[0].result.success) {
    throw new Error(`图片上传失败: ${uploadResult[0].result.error}`);
  }

  // 模块2：随机等待图片上传 5~15秒
  publishState.currentAction = '等待图片上传完成';
  await randomDelay(5000, 15000);

  // 模块3：模拟真人输入填写内容 + 发布
  publishState.currentAction = '填写笔记内容';
  notifyPopup('ACTION_UPDATE');

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (contentData, productId) => {
      // ===== 模块3：模拟真人交互的辅助函数 =====
      
      // 模拟完整鼠标点击事件链
      function simulateClick(element) {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width * (0.3 + Math.random() * 0.4);
        const y = rect.top + rect.height * (0.3 + Math.random() * 0.4);
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        element.dispatchEvent(new MouseEvent('mouseover', opts));
        element.dispatchEvent(new MouseEvent('mouseenter', opts));
        element.dispatchEvent(new MouseEvent('mousemove', opts));
        element.dispatchEvent(new MouseEvent('mousedown', opts));
        element.dispatchEvent(new MouseEvent('mouseup', opts));
        element.dispatchEvent(new MouseEvent('click', opts));
      }

      // 模拟逐字输入标题（带完整键盘事件链）
      async function simulateTyping(element, text) {
        element.focus();
        element.dispatchEvent(new Event('focus', { bubbles: true }));
        element.value = '';

        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          const keyOpts = { key: char, code: 'Key' + char.toUpperCase(), bubbles: true, cancelable: true };

          element.dispatchEvent(new KeyboardEvent('keydown', keyOpts));

          // 用 nativeInputValueSetter 确保 React 受控组件能同步
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          );
          if (nativeSetter && nativeSetter.set) {
            nativeSetter.set.call(element, text.substring(0, i + 1));
          } else {
            element.value = text.substring(0, i + 1);
          }

          element.dispatchEvent(new Event('input', { bubbles: true }));
          element.dispatchEvent(new KeyboardEvent('keyup', keyOpts));

          // 每个字符间随机停顿 50~250ms，模拟真人打字速度
          await new Promise(r => setTimeout(r, 50 + Math.random() * 200));
        }

        element.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // 正文输入（一次性填入）
      function simulateEditorInput(editor, bodyText, tags) {
        editor.focus();
        editor.innerHTML = '';

        const lines = bodyText.split('\n');
        lines.forEach(line => {
          const p = document.createElement('p');
          if (line.trim() === '') {
            p.innerHTML = '<br>';
          } else {
            p.textContent = line;
          }
          editor.appendChild(p);
        });

        // 标签
        if (tags && tags.length > 0) {
          const tagP = document.createElement('p');
          tags.forEach((tag, idx) => {
            if (idx > 0) tagP.appendChild(document.createTextNode(' '));
            const tagLink = document.createElement('a');
            tagLink.className = 'tiptap-topic';
            tagLink.setAttribute('data-topic', JSON.stringify({ name: tag.replace('#', ''), id: 'auto-generated-id' }));
            tagLink.contentEditable = 'false';
            tagLink.innerHTML = `${tag}<span class="content-hide">[话题]#</span>`;
            tagP.appendChild(tagLink);
          });
          editor.appendChild(tagP);
        }

        editor.dispatchEvent(new Event('input', { bubbles: true }));
        editor.dispatchEvent(new Event('change', { bubbles: true }));
      }

      // ===== 主流程 =====
      return new Promise(async (resolve) => {
        // 随机停顿 1~4秒再开始填写
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));

        try {
          // 标题
          const titleSelectors = [
            '#web > div > div > div > div > div.body > div.content > div.plugin.title-container > div > div > div.input > div.d-input-wrapper.d-inline-block.c-input_inner > div > input',
            '.titleInput input',
            'input[placeholder*="标题"]',
            'input.d-text[type="text"]'
          ];
          let titleInput = null;
          for (const sel of titleSelectors) {
            titleInput = document.querySelector(sel);
            if (titleInput) break;
          }
          if (titleInput) {
            await simulateTyping(titleInput, contentData.title);
          }

          // 标题填完后随机停顿 1~3秒
          await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));

          // 正文
          const editorSelectors = [
            '#web > div > div > div > div > div.body > div.content > div.plugin.editor-container > div > div > div.editor-container > div.editor-content > div > div',
            '#quillEditor > div',
            '.editor-content > div > div',
            '[data-placeholder*="正文"]'
          ];
          let editor = null;
          for (const sel of editorSelectors) {
            editor = document.querySelector(sel);
            if (editor) break;
          }

          if (editor) {
            await simulateEditorInput(editor, contentData.body, contentData.tags);

            // 填完正文后随机停顿 2~6秒
            await new Promise(r => setTimeout(r, 2000 + Math.random() * 4000));

            // 发布流程
            if (productId) {
              // 添加商品（内部延时也随机化）
              await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
              const addBtn = document.querySelector('#web > div > div > div.publish-page-container > div.style-override-container.red-theme-override-container > div > div.publish-page-content > div.publish-page-content-business > div.publish-page-content-business-content.mt0 > div.button-group-content > div > div > div > div.multi-good-select-empty-btn > button > div > span');
              if (addBtn) {
                simulateClick(addBtn);
                await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
                const searchBtn = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.d-grid > div:nth-child(2) > div > div > div');
                if (searchBtn) {
                  simulateClick(searchBtn);
                  await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
                  const searchInput = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.d-grid > div:nth-child(2) > div > div > div > div');
                  if (searchInput) {
                    searchInput.focus();
                    document.execCommand('insertText', false, productId);
                    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));
                    const checkbox = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.goods-list-container > div.goods-list-normal > div > div.good-card-container > div.d-grid.d-checkbox.d-checkbox-main.d-clickable.good-selected > span');
                    if (checkbox) {
                      simulateClick(checkbox);
                      await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
                      const saveBtn = document.querySelector('body > div.d-modal-mask > div > div.d-modal-footer > div > button > div');
                      if (saveBtn) {
                        simulateClick(saveBtn);
                        await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
                        clickPublishButton(resolve);
                      } else { resolve({ success: false, error: '未找到保存按钮' }); }
                    } else { resolve({ success: false, error: '未找到商品选择框' }); }
                  } else { resolve({ success: false, error: '未找到搜索输入框' }); }
                } else { resolve({ success: false, error: '未找到搜索按钮' }); }
              } else { resolve({ success: false, error: '未找到添加商品按钮' }); }
            } else {
              await new Promise(r => setTimeout(r, 1000 + Math.random() * 3000));
              clickPublishButton(resolve);
            }
          } else {
            resolve({ success: false, error: '未找到正文编辑器' });
          }

          function clickPublishButton(cb) {
            const publishBtn = document.querySelector('#web > div > div > div.publish-page-container > div.publish-page-publish-btn > button.d-button.d-button-default.d-button-with-content.--color-static.bold.--color-bg-fill.--color-text-paragraph.custom-button.bg-red');
            if (publishBtn) {
              simulateClick(publishBtn);
              cb({ success: true });
            } else {
              cb({ success: false, error: '未找到发布按钮' });
            }
          }

        } catch (error) {
          resolve({ success: false, error: error.message });
        }
      });
    },
    args: [noteData, noteData.productId || '']
  });

  // 模块2：随机等待发布完成 25~50秒
  publishState.currentAction = '等待发布完成';
  await randomDelay(25000, 50000);
  publishState.currentAction = '发布完成';
}

// ===================== 工具函数 =====================

// 随机延迟（毫秒范围）
function randomDelay(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(r => setTimeout(r, delay));
}

// 随机整数
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function calculateWaitTime(config) {
  if (!config) config = publishState.publishConfig;
  let baseTime;
  if (config.intervalType === 'random') {
    baseTime = Math.floor(Math.random() * (config.maxInterval - config.minInterval + 1)) + config.minInterval;
  } else {
    baseTime = config.fixedInterval;
  }
  // 在基础时间上加 ±35% 的随机抖动，打破规律性
  const jitter = baseTime * 0.35;
  const finalTime = Math.floor(baseTime + (Math.random() * 2 - 1) * jitter);
  return Math.max(finalTime, 60); // 最少60秒
}


function notifyPopup(type, data) {
  const time = new Date().toLocaleTimeString();
  let message = '';

  switch (type) {
    case 'NOTE_PUBLISHED':
      message = `[${time}] 第${data.index + 1}篇发布成功（已发 ${data.current}/${data.total} 篇）`;
      break;
    case 'WAITING':
      message = `[${time}] 正在准备第 ${data.nextIndex + 1} 篇（${data.current}/${data.total}）`;
      break;
    case 'ACTION_UPDATE':
      message = `[${time}] ${publishState.currentAction}`;
      break;
    case 'ERROR':
      message = `[${time}] 发布出错: ${data}`;
      break;
    case 'COMPLETED':
      message = `[${time}] 所有笔记发布完成！`;
      break;
    case 'STOPPED':
      message = `[${time}] 已停止发布`;
      break;
    case 'COUNTDOWN':
      message = `[${time}] 倒计时: ${data.remainingTime}s`;
      break;
    default:
      message = `[${time}] ${publishState.currentAction}`;
  }

  // 保存精简状态
  chrome.storage.local.set({
    pState: {
      i: publishState.isPublishing,
      c: publishState.currentIndex,
      t: publishState.totalNotes,
      a: publishState.currentAction,
      w: publishState.waitTime
    }
  });

  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    data: {
      message,
      state: {
        isPublishing: publishState.isPublishing,
        currentIndex: publishState.currentIndex,
        totalNotes: publishState.totalNotes,
        currentAction: publishState.currentAction,
        waitTime: publishState.waitTime,
        time,
        countdown: type === 'COUNTDOWN' ? { current: data.remainingTime, total: data.totalTime } : null
      }
    }
  }).catch(() => {});
}

async function cleanup() {
  publishState = {
    isPublishing: false,
    currentIndex: 0,
    totalNotes: 0,
    publishConfig: null,
    tabId: null,
    currentAction: '',
    waitTime: 0
  };
  await chrome.alarms.clear('noteInterval');
  await chrome.alarms.clear('dailyPublishDelayed');
  await chrome.storage.local.remove(['pState', 'publishProgress']);
}

async function stopPublishing() {
  publishState.isPublishing = false;
  await chrome.alarms.clear('noteInterval');
  await chrome.alarms.clear('dailyPublishDelayed');
  await chrome.storage.local.remove('publishProgress');
  notifyPopup('STOPPED');
  try {
    if (publishState.tabId) {
      await chrome.tabs.remove(publishState.tabId);
    }
  } catch (e) {}
}

// ===================== 笔记元数据存取 =====================
// popup.js 导入笔记后通过 storage 共享元数据给 background
async function getNotesMeta() {
  const data = await chrome.storage.local.get('notesMeta');
  return data.notesMeta || [];
}

// ===================== 启动恢复 =====================
chrome.runtime.onStartup.addListener(async () => {
  try {
    // 恢复定时发布
    const data = await chrome.storage.local.get(['scheduleConfig', 'publishProgress']);
    if (data.scheduleConfig) {
      scheduleConfig = data.scheduleConfig;
      await setDailyAlarm(scheduleConfig.dailyStartTime);
      console.log('已恢复定时发布设置');
    }
    // 恢复发布进度到内存（alarm 会自动触发 publishCurrentNote）
    if (data.publishProgress && data.publishProgress.isPublishing) {
      const p = data.publishProgress;
      publishState.isPublishing = true;
      publishState.currentIndex = p.currentIndex;
      publishState.totalNotes = p.totalNotes;
      publishState.publishConfig = p.publishConfig;
      publishState.tabId = p.tabId;
      publishState.currentAction = p.currentAction || '等待发布下一篇';
      console.log('已恢复发布进度，等待 alarm 触发继续发布');
    }
  } catch (e) {
    console.error('恢复状态失败:', e);
  }
});

// 错误处理
async function handleError() {
  publishState.isPublishing = false;
  try {
    if (publishState.tabId) {
      await chrome.tabs.remove(publishState.tabId);
    }
  } catch (e) {}
}
