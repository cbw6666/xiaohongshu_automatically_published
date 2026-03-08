// 修改发布状态对象
let publishState = {
  isPublishing: false,
  currentIndex: 0,
  totalNotes: 0,
  publishConfig: null,
  tabId: null,
  currentAction: '',
  waitTime: 0
};

// 处理插件图标点击事件，打开侧边栏
chrome.action.onClicked.addListener(async (tab) => {
  try {
    // 打开侧边栏
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (error) {
    console.error('打开侧边栏失败:', error);
    // 如果侧边栏API不可用，降级到弹窗
    try {
      await chrome.action.setPopup({ popup: 'popup.html' });
    } catch (fallbackError) {
      console.error('设置弹窗失败:', fallbackError);
    }
  }
});

// 监听来自 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 立即返回 true 表示我们将异步发送响应
  const handleMessage = async () => {
    // 检查认证状态（除了获取状态和停止发布）
    if (message.type !== 'GET_STATE' && message.type !== 'STOP_PUBLISH') {
      const authData = await chrome.storage.local.get('authState');
      if (!authData.authState || !authData.authState.isAuthenticated) {
        return { error: '未认证，请先进行卡密验证' };
      }
      
      // 检查卡密是否到期
      if (authData.authState.vipExpTime) {
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime >= authData.authState.vipExpTime) {
          // 清除过期认证状态
          await chrome.storage.local.remove('authState');
          return { error: '卡密已到期，请重新验证' };
        }
      }
    }
    
    switch (message.type) {
      case 'START_PUBLISH':
        await startPublishing(message.data);
        return { success: true };
      case 'GET_STATE':
        return publishState;
      case 'STOP_PUBLISH':
        await stopPublishing();
        return { success: true };
    }
  };

  // 使用 Promise 处理异步响应
  handleMessage().then(response => {
    if (sendResponse) {
      sendResponse(response);
    }
  }).catch(error => {
    console.error('处理消息出错:', error);
    if (sendResponse) {
      sendResponse({ error: error.message });
    }
  });

  // 返回 true 表示我们会异步调用 sendResponse
  return true;
});

// 修改开始发布函数
async function startPublishing(data) {
  if (publishState.isPublishing) return;

  try {
    // 重置发布状态
    publishState = {
      isPublishing: true,
      currentIndex: 0,
      totalNotes: data.notes.length,
      publishConfig: {
        intervalType: data.publishConfig.intervalType,
        fixedInterval: data.publishConfig.fixedInterval,
        minInterval: data.publishConfig.minInterval,
        maxInterval: data.publishConfig.maxInterval
      },
      tabId: null,
      currentAction: '准备发布',
      waitTime: 0
    };

    // 创建新标签页
    const tab = await chrome.tabs.create({
      url: 'https://creator.xiaohongshu.com/publish/publish',
      active: true
    });
    publishState.tabId = tab.id;

    // 开始发布循环
    for (let i = 0; i < data.notes.length; i++) {
      if (!publishState.isPublishing) break;

      try {
        // 发布当前笔记
        await publishNote(data.notes[i]);
        
        // 更新进度
        publishState.currentIndex = i + 1;
        notifyPopup('NOTE_PUBLISHED', {
          index: i,
          total: data.notes.length
        });

        // 如果不是最后一篇，等待指定时间
        if (i < data.notes.length - 1) {
          const waitTime = calculateWaitTime();
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
        await handleError();
        break;
      }
    }

    // 发布完成
    if (publishState.currentIndex >= data.notes.length) {
      notifyPopup('COMPLETED');
    }

    // 清理状态
    await cleanup();

  } catch (error) {
    console.error('启动发布失败:', error);
    notifyPopup('ERROR', error.message);
    await cleanup();
  }
}

// 计算等待时间
function calculateWaitTime() {
  const config = publishState.publishConfig;
  if (config.intervalType === 'random') {
    return Math.floor(
      Math.random() * (config.maxInterval - config.minInterval + 1)
    ) + config.minInterval;
  }
  return config.fixedInterval;
}

// 错误处理
async function handleError() {
  publishState.isPublishing = false;
  
  // 尝试关闭发布标签页
  try {
    if (publishState.tabId) {
      await chrome.tabs.remove(publishState.tabId);
    }
  } catch (error) {
    console.error('关闭标签页失败:', error);
  }
}

// 修改通知函数
function notifyPopup(type, data) {
  const time = new Date().toLocaleTimeString();
  let message = '';

  // 根据不同类型的消息生成日志内容
  switch (type) {
    case 'START_PUBLISH':
      message = `[${time}] 开始发布任务，共 ${publishState.totalNotes} 篇笔记`;
      break;
    case 'NOTE_PUBLISHED':
      message = `[${time}] 成功发布第 ${data.index + 1}/${data.total} 篇笔记`;
      break;
    case 'WAITING':
      const nextTime = new Date(Date.now() + data.waitTime * 1000).toLocaleTimeString();
      message = `[${time}] 等待发布第 ${data.nextIndex + 1} 篇笔记...
预计发布时间: ${nextTime}
等待时间: ${data.waitTime} 秒`;
      break;
    case 'ACTION_UPDATE':
      message = `[${time}] 正在发布第 ${publishState.currentIndex + 1} 篇：${publishState.currentAction}`;
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
      message = `[${time}] 倒计时: ${data.remainingTime}/${data.totalTime} 秒`;
      break;
    default:
      message = `[${time}] ${publishState.currentAction}`;
  }

  // 保存状态
  chrome.storage.local.set({
    pState: {
      i: publishState.isPublishing,
      c: publishState.currentIndex,
      t: publishState.totalNotes,
      a: publishState.currentAction,
      w: publishState.waitTime
    }
  });

  // 发送消息到 popup
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
        countdown: type === 'COUNTDOWN' ? {
          current: data.remainingTime,
          total: data.totalTime
        } : null
      }
    }
  }).catch(() => {});
}

// 修改清理函数
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

// 停止发布
async function stopPublishing() {
  publishState.isPublishing = false;
  notifyPopup('STOPPED');
  
  // 尝试关闭发布标签页
  try {
    if (publishState.tabId) {
      await chrome.tabs.remove(publishState.tabId);
    }
  } catch (error) {
    console.error('关闭标签页失败:', error);
  }
}

// 在扩展启动时恢复状态
chrome.runtime.onStartup.addListener(async () => {
  try {
    const data = await chrome.storage.local.get('pState');
    if (data.pState && data.pState.i) {
      publishState = {
        isPublishing: data.pState.i,
        currentIndex: data.pState.c,
        totalNotes: data.pState.t,
        publishConfig: {
          intervalType: data.pState.intervalType,
          fixedInterval: data.pState.fixedInterval,
          minInterval: data.pState.minInterval,
          maxInterval: data.pState.maxInterval
        },
        tabId: null,
        currentAction: data.pState.a,
        waitTime: data.pState.w
      };
      await startPublishing({ notes: [], publishConfig: { intervalType: data.pState.intervalType, fixedInterval: data.pState.fixedInterval, minInterval: data.pState.minInterval, maxInterval: data.pState.maxInterval } });
    }
  } catch (error) {
    console.error('恢复状态失败:', error);
  }
});

// 修改发布笔记函数
async function publishNote(noteData) {
  try {
    // 更新上传图片状态
    publishState.currentAction = '正在上传图片...';
    notifyPopup('ACTION_UPDATE');

    // 获取当前标签页
    publishState.currentAction = '打开发布页面';
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    await chrome.tabs.update(tab.id, { 
      url: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch' 
    });
    
    // 等待页面加载
    publishState.currentAction = '等待页面加载';
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 点击图文按钮
    publishState.currentAction = '点击图文按钮';
    const clickTextResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => {
        return new Promise((resolve) => {
          const selectors = [
            '#web > div > div > div > div.header > div.header-tabs > div:nth-child(3) > span',
            '#web > div.outarea.upload-c > div > div > div.header > div:nth-child(2) > span',
            '#web > div > div > div > div.header > div:nth-child(2) > span',
            '.header-tabs > div:nth-child(3) > span',
            'span:contains("图文")'
          ];
          
          let found = false;
          const waitForButton = setInterval(() => {
            for (const selector of selectors) {
              let btn;
              if (selector.includes(':contains')) {
                // 处理包含文本的选择器
                const spans = document.querySelectorAll('span');
                btn = Array.from(spans).find(span => span.textContent.includes('图文'));
              } else {
                btn = document.querySelector(selector);
              }
              
              if (btn) {
                clearInterval(waitForButton);
                console.log('找到图文按钮，使用选择器:', selector);
                btn.click();
                found = true;
                resolve({ success: true, selector });
                break;
              }
            }
          }, 1000);

          // 20秒后超时
          setTimeout(() => {
            if (!found) {
              clearInterval(waitForButton);
              console.error('未找到图文按钮，尝试的选择器:', selectors);
              resolve({ success: false, error: '未找到图文按钮' });
            }
          }, 20000);
        });
      }
    });

    if (!clickTextResult[0].result.success) {
      throw new Error(clickTextResult[0].result.error);
    }

    // 等待页面切换
    publishState.currentAction = '等待页面切换';
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 上传图片
    publishState.currentAction = '上传图片';
    const uploadResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: (imageDataArray) => {
        return new Promise((resolve) => {
          // 尝试多个可能的选择器，以提高兼容性
          const selectors = [
            '#web > div > div > div > div.upload-content.hasBannerHeight > div.upload-wrapper > div > input',
            '#web > div > div > div > div.upload-content > div.upload-wrapper > div > input',
            '#web > div.outarea.upload-c > div > div > div.upload-content > div.upload-wrapper > div > input',
            'input[data-v-4506f808][data-v-7cbccdb2-s].upload-input[type="file"][multiple][accept*=".jpg"]',
            '.upload-input[type="file"]',
            'input[type="file"][multiple][accept*=".jpg"]',
            'input[type="file"][accept*="image"]'
          ];
          
          let uploadInput = null;
          let usedSelector = '';
          
          for (const selector of selectors) {
            uploadInput = document.querySelector(selector);
            if (uploadInput) {
              usedSelector = selector;
              console.log('找到上传输入框，使用选择器:', selector);
              break;
            }
          }
          
          if (uploadInput) {
            // 创建 DataTransfer 对象
            const dataTransfer = new DataTransfer();
            
            // 将 base64 数据转换为 File 对象
            imageDataArray.forEach((imageData, index) => {
              // 从 base64 创建 Blob
              const byteString = atob(imageData.split(',')[1]);
              const mimeString = imageData.split(',')[0].split(':')[1].split(';')[0];
              const ab = new ArrayBuffer(byteString.length);
              const ia = new Uint8Array(ab);
              for (let i = 0; i < byteString.length; i++) {
                ia[i] = byteString.charCodeAt(i);
              }
              const blob = new Blob([ab], { type: mimeString });
              
              // 创建 File 对象
              const file = new File([blob], `image${index + 1}.jpg`, { type: mimeString });
              dataTransfer.items.add(file);
            });

            // 设置文件到上传输入框
            uploadInput.files = dataTransfer.files;
            uploadInput.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('图片上传成功，使用选择器:', usedSelector);
            resolve({ success: true, selector: usedSelector });
          } else {
            console.error('未找到上传输入框，尝试的选择器:', selectors);
            resolve({ success: false, error: '未找到上传输入框' });
          }
        });
      },
      args: [Object.values(noteData.imageUrls)]
    });

    // 检查上传结果
    if (!uploadResult[0].result.success) {
      throw new Error(`图片上传失败: ${uploadResult[0].result.error}`);
    }

    // 等待图片上传
    publishState.currentAction = '等待图片上传完成';
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 更新填写内容状态
    publishState.currentAction = '正在填写笔记内容...';
    notifyPopup('ACTION_UPDATE');

    // 填写内容
    publishState.currentAction = '填写笔记内容';
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: (contentData, productId) => {
        return new Promise((resolve) => {
          function logError(message, element = null) {
            console.error(`[内容填写] ${message}`, element);
          }
          
          function logSuccess(message) {
            console.log(`[内容填写] ${message}`);
          }
          
          setTimeout(() => {
            try {
              // 填写标题
              const titleSelectors = [
                '#web > div > div > div > div > div.body > div.content > div.plugin.title-container > div > div > div.input > div.d-input-wrapper.d-inline-block.c-input_inner > div > input',
                '.titleInput input',
                'input[placeholder*="标题"]',
                'input.d-text[type="text"]'
              ];
              
              let titleInput = null;
              for (const selector of titleSelectors) {
                titleInput = document.querySelector(selector);
                if (titleInput) {
                  logSuccess(`找到标题输入框，使用选择器: ${selector}`);
                  break;
                }
              }
              
              if (titleInput) {
                titleInput.value = contentData.title;
                titleInput.dispatchEvent(new Event('input', { bubbles: true }));
                titleInput.dispatchEvent(new Event('change', { bubbles: true }));
                logSuccess(`标题填写成功: ${contentData.title}`);
              } else {
                logError('未找到标题输入框');
              }

              // 填写正文
              const editorSelectors = [
                '#web > div > div > div > div > div.body > div.content > div.plugin.editor-container > div > div > div.editor-container > div.editor-content > div > div',
                '#quillEditor > div',
                '.editor-content > div > div',
                '[data-placeholder*="正文"]'
              ];
              
              let editor = null;
              for (const selector of editorSelectors) {
                editor = document.querySelector(selector);
                if (editor) {
                  logSuccess(`找到正文编辑器，使用选择器: ${selector}`);
                  break;
                }
              }
              
              if (editor) {
                editor.click();
                editor.focus();
                
                // 清空现有内容
                editor.innerHTML = '';
                
                // 处理正文内容，每行创建一个p标签
                const lines = contentData.body.split('\n');
                
                lines.forEach((line, index) => {
                  const p = document.createElement('p');
                  if (line.trim() === '') {
                    // 空行
                    p.innerHTML = '<br class="ProseMirror-trailingBreak">';
                  } else {
                    // 有内容的行
                    p.textContent = line;
                  }
                  editor.appendChild(p);
                });
                
                logSuccess(`正文填写成功，共 ${lines.length} 行`);
                
                // 处理标签
                if (contentData.tags && contentData.tags.length > 0) {
                  // 创建标签段落
                  const tagP = document.createElement('p');
                  
                  contentData.tags.forEach((tag, index) => {
                    if (index > 0) {
                      // 添加空格分隔
                      tagP.appendChild(document.createTextNode(' '));
                    }
                    
                    // 创建标签链接
                    const tagLink = document.createElement('a');
                    tagLink.className = 'tiptap-topic';
                    tagLink.setAttribute('data-topic', JSON.stringify({
                      name: tag.replace('#', ''),
                      id: 'auto-generated-id'
                    }));
                    tagLink.contentEditable = 'false';
                    tagLink.innerHTML = `${tag}<span class="content-hide">[话题]#</span>`;
                    
                    tagP.appendChild(tagLink);
                  });
                  
                  editor.appendChild(tagP);
                  logSuccess(`标签填写成功，共 ${contentData.tags.length} 个标签`);
                } else {
                  logError('没有标签需要填写');
                }
                
                // 触发编辑器更新事件
                editor.dispatchEvent(new Event('input', { bubbles: true }));
                editor.dispatchEvent(new Event('change', { bubbles: true }));
                
                // 等待一段时间后处理发布
                setTimeout(() => {
                  // 处理商品链接
                  if (productId) {
                    logSuccess(`开始处理商品ID: ${productId}`);
                    setTimeout(() => {
                      // 点击添加商品按钮
                      const addProductButton = document.querySelector('#web > div > div > div.publish-page-container > div.style-override-container.red-theme-override-container > div > div.publish-page-content > div.publish-page-content-business > div.publish-page-content-business-content.mt0 > div.button-group-content > div > div > div > div.multi-good-select-empty-btn > button > div > span');
                      if (addProductButton) {
                        addProductButton.click();
                        logSuccess('点击添加商品按钮成功');

                        // 等待弹窗出现并点击搜索商品ID按钮
                        setTimeout(() => {
                          const searchButton = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.d-grid > div:nth-child(2) > div > div > div');
                          if (searchButton) {
                            searchButton.click();
                            logSuccess('点击搜索按钮成功');

                            // 等待输入框出现并输入商品ID
                            setTimeout(() => {
                              const searchInput = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.d-grid > div:nth-child(2) > div > div > div > div');
                              if (searchInput) {
                                searchInput.focus();
                                document.execCommand('insertText', false, productId);
                                searchInput.dispatchEvent(new Event('input', { bubbles: true }));
                                logSuccess('商品ID输入成功');

                                // 等待搜索结果并勾选商品
                                setTimeout(() => {
                                  const checkboxSpan = document.querySelector('body > div.d-modal-mask > div > div.d-modal-content > div > div.goods-list-container > div.goods-list-normal > div > div.good-card-container > div.d-grid.d-checkbox.d-checkbox-main.d-clickable.good-selected > span');
                                  if (checkboxSpan) {
                                    checkboxSpan.click();
                                    logSuccess('商品选择成功');

                                    // 点击保存按钮
                                    setTimeout(() => {
                                      const saveButton = document.querySelector('body > div.d-modal-mask > div > div.d-modal-footer > div > button > div');
                                      if (saveButton) {
                                        saveButton.click();
                                        logSuccess('商品保存成功');
                                        
                                        // 等待保存完成后再点击发布按钮
                                        setTimeout(() => {
                                          const publishButton = document.querySelector('#web > div > div > div.publish-page-container > div.publish-page-publish-btn > button.d-button.d-button-default.d-button-with-content.--color-static.bold.--color-bg-fill.--color-text-paragraph.custom-button.bg-red');
                                          if (publishButton) {
                                            publishButton.click();
                                            logSuccess('发布按钮点击成功');
                                            resolve({ success: true, message: '内容填写和发布完成' });
                                          } else {
                                            logError('未找到发布按钮');
                                            resolve({ success: false, error: '未找到发布按钮' });
                                          }
                                        }, 2000);
                                      } else {
                                        logError('未找到保存按钮');
                                        resolve({ success: false, error: '未找到保存按钮' });
                                      }
                                    }, 1000);
                                  } else {
                                    logError('未找到商品选择框');
                                    resolve({ success: false, error: '未找到商品选择框' });
                                  }
                                }, 2000);
                              } else {
                                logError('未找到商品ID输入框');
                                resolve({ success: false, error: '未找到商品ID输入框' });
                              }
                            }, 1000);
                          } else {
                            logError('未找到搜索按钮');
                            resolve({ success: false, error: '未找到搜索按钮' });
                          }
                        }, 1000);
                      } else {
                        logError('未找到添加商品按钮');
                        resolve({ success: false, error: '未找到添加商品按钮' });
                      }
                    }, 1000);
                  } else {
                    // 如果没有商品ID，直接点击发布按钮
                    logSuccess('没有商品ID，直接发布');
                    setTimeout(() => {
                      const publishButton = document.querySelector('#web > div > div > div.publish-page-container > div.publish-page-publish-btn > button.d-button.d-button-default.d-button-with-content.--color-static.bold.--color-bg-fill.--color-text-paragraph.custom-button.bg-red');
                      if (publishButton) {
                        publishButton.click();
                        logSuccess('发布按钮点击成功');
                        resolve({ success: true, message: '内容填写和发布完成' });
                      } else {
                        logError('未找到发布按钮');
                        resolve({ success: false, error: '未找到发布按钮' });
                      }
                    }, 1000);
                  }
                }, 2000);
                
              } else {
                logError('未找到正文编辑器');
                resolve({ success: false, error: '未找到正文编辑器' });
              }
              
            } catch (error) {
              logError('内容填写过程中发生错误', error);
              resolve({ success: false, error: error.message });
            }
          }, 1000);
        });
      },
      args: [noteData, noteData.productId || '']
    });

    // 检查内容填写结果
    const fillResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: () => {
        // 返回填写结果的详细信息
        return {
          success: true,
          details: {
            title: document.querySelector('#web > div > div > div > div > div.body > div.content > div.plugin.title-container > div > div > div.input > div.d-input-wrapper.d-inline-block.c-input_inner > div > input')?.value || '未找到标题',
            contentLines: document.querySelectorAll('#web > div > div > div > div > div.body > div.content > div.plugin.editor-container > div > div > div.editor-container > div.editor-content > div > div p').length || 0,
            tags: document.querySelectorAll('#web > div > div > div > div > div.body > div.content > div.plugin.editor-container > div > div > div.editor-container > div.editor-content > div > div a.tiptap-topic').length || 0
          }
        };
      }
    });

    if (fillResult && fillResult[0] && fillResult[0].result) {
      const details = fillResult[0].result.details;
      console.log('内容填写检查结果:', details);
      publishState.currentAction = `内容填写完成 - 标题: ${details.title}, 正文: ${details.contentLines}行, 标签: ${details.tags}个`;
    }

    // 等待发布完成
    publishState.currentAction = '等待发布完成';
    await new Promise(resolve => setTimeout(resolve, 30000));

    publishState.currentAction = '发布完成';

  } catch (error) {
    console.error('发布笔记失败:', error);
    publishState.currentAction = `发布失败: ${error.message}`;
    notifyPopup('ERROR', error.message);
    throw error;
  }
}

// 修改等待函数
async function wait(seconds) {
  for (let i = seconds; i > 0; i--) {
    if (!publishState.isPublishing) break;
    
    publishState.waitTime = i;
    publishState.currentAction = `等待 ${i} 秒后发布下一篇...`;
    
    // 发送倒计时状态更新
    notifyPopup('COUNTDOWN', {
      remainingTime: i,
      totalTime: seconds
    });
    
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  publishState.waitTime = 0;
} 