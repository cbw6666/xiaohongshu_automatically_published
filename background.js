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
let scheduleConfig = null; // { dailyStartTime, dailyCount, startRow, publishConfig, currentDayOffset }

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

// ===================== 立即发布 =====================
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

    for (let i = startIndex; i < endIndex; i++) {
      if (!publishState.isPublishing) break;

      try {
        const note = notesData[i];
        // 从 IndexedDB 逐篇读取图片
        const blobs = await getAllImagesForNote(i, note.imageCount);
        // 转 base64 用于 content script
        const imageDataUrls = [];
        for (const blob of blobs) {
          imageDataUrls.push(await blobToDataUrl(blob));
        }

        await publishSingleNote(note, imageDataUrls, tab.id);

        publishState.currentIndex++;
        notifyPopup('NOTE_PUBLISHED', {
          index: i,
          total: publishState.totalNotes
        });

        // 非最后一篇，等待间隔
        if (i < endIndex - 1) {
          const waitTime = calculateWaitTime(publishConfig);
          publishState.waitTime = waitTime;
          publishState.currentAction = '等待发布下一篇';

          notifyPopup('WAITING', {
            nextIndex: i + 1,
            waitTime,
            currentTime: new Date().toLocaleTimeString()
          });

          await wait(waitTime);
        }

      } catch (error) {
        console.error('发布笔记失败:', error);
        notifyPopup('ERROR', error.message);
        break;
      }
    }

    if (publishState.currentIndex >= publishState.totalNotes) {
      notifyPopup('COMPLETED');
    }

    await cleanup();

  } catch (error) {
    console.error('启动发布失败:', error);
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
    currentDayOffset: 0
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

// Alarm 触发
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'dailyPublish') return;
  
  // 从 storage 恢复 scheduleConfig
  if (!scheduleConfig) {
    const data = await chrome.storage.local.get('scheduleConfig');
    scheduleConfig = data.scheduleConfig;
  }

  if (!scheduleConfig) return;

  await handleDailyStart();
});

async function handleDailyStart() {
  if (publishState.isPublishing) {
    console.log('跳过定时发布：当前有任务在执行');
    return;
  }

  const notesData = await getNotesMeta();
  if (!notesData || notesData.length === 0) return;

  const startIndex = (scheduleConfig.startRow - 1) + (scheduleConfig.currentDayOffset * scheduleConfig.dailyCount);
  const count = Math.min(scheduleConfig.dailyCount, notesData.length - startIndex);

  if (count <= 0) {
    console.log('所有笔记已发布完毕');
    notifyPopup('COMPLETED');
    return;
  }

  // 通知 popup
  chrome.runtime.sendMessage({
    type: 'DAILY_PUBLISH_START',
    data: { day: scheduleConfig.currentDayOffset + 1, startRow: startIndex + 1 }
  }).catch(() => {});

  // 递增天数偏移
  scheduleConfig.currentDayOffset++;
  await chrome.storage.local.set({ scheduleConfig });

  // 启动发布
  await startPublishing({
    startIndex,
    count,
    publishConfig: scheduleConfig.publishConfig
  });

  // 完成后通知
  chrome.runtime.sendMessage({
    type: 'DAILY_PUBLISH_DONE',
    data: { count }
  }).catch(() => {});
}

// ===================== 发布单篇笔记 =====================
async function publishSingleNote(noteData, imageDataUrls, tabId) {
  publishState.currentAction = '打开发布页面';
  notifyPopup('ACTION_UPDATE');

  await chrome.tabs.update(tabId, {
    url: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch'
  });

  publishState.currentAction = '等待页面加载';
  await new Promise(r => setTimeout(r, 5000));

  // 点击图文按钮
  publishState.currentAction = '点击图文按钮';
  const clickResult = await chrome.scripting.executeScript({
    target: { tabId },
    function: () => {
      return new Promise((resolve) => {
        const selectors = [
          '#web > div > div > div > div.header > div.header-tabs > div:nth-child(3) > span',
          '#web > div.outarea.upload-c > div > div > div.header > div:nth-child(2) > span',
          '#web > div > div > div > div.header > div:nth-child(2) > span',
          '.header-tabs > div:nth-child(3) > span'
        ];

        let found = false;
        const timer = setInterval(() => {
          // 先尝试精确选择器
          for (const sel of selectors) {
            const btn = document.querySelector(sel);
            if (btn) {
              clearInterval(timer);
              btn.click();
              found = true;
              resolve({ success: true });
              return;
            }
          }
          // 回退: 文本匹配
          const spans = document.querySelectorAll('span');
          const btn = Array.from(spans).find(s => s.textContent.includes('图文'));
          if (btn) {
            clearInterval(timer);
            btn.click();
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

  await new Promise(r => setTimeout(r, 5000));

  // 上传图片
  publishState.currentAction = '上传图片';
  notifyPopup('ACTION_UPDATE');

  const uploadResult = await chrome.scripting.executeScript({
    target: { tabId },
    function: (imageDataArray) => {
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

  publishState.currentAction = '等待图片上传完成';
  await new Promise(r => setTimeout(r, 5000));

  // 填写内容 + 发布
  publishState.currentAction = '填写笔记内容';
  notifyPopup('ACTION_UPDATE');

  await chrome.scripting.executeScript({
    target: { tabId },
    function: (contentData, productId) => {
      return new Promise((resolve) => {
        setTimeout(() => {
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
              titleInput.value = contentData.title;
              titleInput.dispatchEvent(new Event('input', { bubbles: true }));
              titleInput.dispatchEvent(new Event('change', { bubbles: true }));
            }

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
              editor.click();
              editor.focus();
              editor.innerHTML = '';

              const lines = contentData.body.split('\n');
              lines.forEach(line => {
                const p = document.createElement('p');
                if (line.trim() === '') {
                  p.innerHTML = '<br class="ProseMirror-trailingBreak">';
                } else {
                  p.textContent = line;
                }
                editor.appendChild(p);
              });

              // 标签
              if (contentData.tags && contentData.tags.length > 0) {
                const tagP = document.createElement('p');
                contentData.tags.forEach((tag, idx) => {
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

              // 发布流程
              setTimeout(() => {
                if (productId) {
                  // 添加商品
                  setTimeout(() => {
                    const addBtn = document.querySelector('#web > div > div > div.publish-page-container > div.style-override-container.red-theme-override-container > div > div.publish-page-content > div.publish-page-content-business > div.publish-page-content-business-content.mt0 > div.button-group-content > div > div > div > div.multi-good-select-empty-btn > button > div > span');
                    if (addBtn) {
                      addBtn.click();
                      setTimeout(() => {
                        const searchBtn = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.d-grid > div:nth-child(2) > div > div > div');
                        if (searchBtn) {
                          searchBtn.click();
                          setTimeout(() => {
                            const searchInput = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.d-grid > div:nth-child(2) > div > div > div > div');
                            if (searchInput) {
                              searchInput.focus();
                              document.execCommand('insertText', false, productId);
                              searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                              setTimeout(() => {
                                const checkbox = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.goods-list-container > div.goods-list-normal > div > div.good-card-container > div.d-grid.d-checkbox.d-checkbox-main.d-clickable.good-selected > span');
                                if (checkbox) {
                                  checkbox.click();
                                  setTimeout(() => {
                                    const saveBtn = document.querySelector('body > div.d-modal-mask > div > div.d-modal-footer > div > button > div');
                                    if (saveBtn) {
                                      saveBtn.click();
                                      setTimeout(() => {
                                        clickPublishButton(resolve);
                                      }, 2000);
                                    } else { resolve({ success: false, error: '未找到保存按钮' }); }
                                  }, 1000);
                                } else { resolve({ success: false, error: '未找到商品选择框' }); }
                              }, 2000);
                            } else { resolve({ success: false, error: '未找到搜索输入框' }); }
                          }, 1000);
                        } else { resolve({ success: false, error: '未找到搜索按钮' }); }
                      }, 1000);
                    } else { resolve({ success: false, error: '未找到添加商品按钮' }); }
                  }, 1000);
                } else {
                  setTimeout(() => {
                    clickPublishButton(resolve);
                  }, 1000);
                }
              }, 2000);
            } else {
              resolve({ success: false, error: '未找到正文编辑器' });
            }

            function clickPublishButton(cb) {
              const publishBtn = document.querySelector('#web > div > div > div.publish-page-container > div.publish-page-publish-btn > button.d-button.d-button-default.d-button-with-content.--color-static.bold.--color-bg-fill.--color-text-paragraph.custom-button.bg-red');
              if (publishBtn) {
                publishBtn.click();
                cb({ success: true });
              } else {
                cb({ success: false, error: '未找到发布按钮' });
              }
            }

          } catch (error) {
            resolve({ success: false, error: error.message });
          }
        }, 1000);
      });
    },
    args: [noteData, noteData.productId || '']
  });

  // 等待发布完成
  publishState.currentAction = '等待发布完成';
  await new Promise(r => setTimeout(r, 30000));
  publishState.currentAction = '发布完成';
}

// ===================== 工具函数 =====================
function calculateWaitTime(config) {
  if (!config) config = publishState.publishConfig;
  if (config.intervalType === 'random') {
    return Math.floor(Math.random() * (config.maxInterval - config.minInterval + 1)) + config.minInterval;
  }
  return config.fixedInterval;
}

async function wait(seconds) {
  for (let i = seconds; i > 0; i--) {
    if (!publishState.isPublishing) break;
    publishState.waitTime = i;
    publishState.currentAction = `等待 ${i} 秒后发布下一篇...`;
    notifyPopup('COUNTDOWN', { remainingTime: i, totalTime: seconds });
    await new Promise(r => setTimeout(r, 1000));
  }
  publishState.waitTime = 0;
}

function notifyPopup(type, data) {
  const time = new Date().toLocaleTimeString();
  let message = '';

  switch (type) {
    case 'NOTE_PUBLISHED':
      message = `[${time}] 成功发布第 ${data.index + 1}/${data.total} 篇笔记`;
      break;
    case 'WAITING':
      message = `[${time}] 等待发布第 ${data.nextIndex + 1} 篇`;
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
  await chrome.storage.local.remove(['pState']);
}

async function stopPublishing() {
  publishState.isPublishing = false;
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
    const data = await chrome.storage.local.get('scheduleConfig');
    if (data.scheduleConfig) {
      scheduleConfig = data.scheduleConfig;
      await setDailyAlarm(scheduleConfig.dailyStartTime);
      console.log('已恢复定时发布设置');
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
