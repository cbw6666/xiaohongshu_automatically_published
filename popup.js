// 卡密验证相关配置
const AUTH_CONFIG = {
  API_URL: 'http://user.weichuang.club/api/user/1002/xhs/2.0/logon',
  APP_ID: '1002',
  VERSION: '2.0',
  SOFTWARE_INDEX: 'xhs'
};

// 卡密验证状态
let authState = {
  isAuthenticated: false,
  token: null,
  cardNo: null,
  vipExpTime: null,
  udid: null
};

// 生成电脑机器码（确保同一台电脑不同浏览器生成完全相同的机器码）
async function generateUDID() {
  try {
    // 获取最稳定的硬件信息，确保同一台电脑不同浏览器结果一致
    const screenInfo = `${screen.width}x${screen.height}`;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const platform = navigator.platform;
    const hardwareConcurrency = navigator.hardwareConcurrency || 4;
    
    // 获取WebGL显卡信息（最稳定的硬件标识）
    let webglVendor = '';
    let webglRenderer = '';
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || '';
          webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '';
        }
      }
    } catch (e) {
      webglVendor = 'unknown_vendor';
      webglRenderer = 'unknown_renderer';
    }
    
    // 获取系统语言（更稳定）
    const systemLanguage = navigator.language.split('-')[0]; // 只取主语言，忽略地区
    
    // 只使用最稳定的硬件信息组合，确保跨浏览器一致性
    const stableMachineInfo = [
      platform,                      // 操作系统平台
      screenInfo,                    // 主屏幕分辨率
      timezone,                      // 时区
      systemLanguage,                // 系统主语言
      hardwareConcurrency.toString(), // CPU核心数
      webglVendor.replace(/\s+/g, ''), // 显卡厂商（移除空格）
      webglRenderer.replace(/\s+/g, '') // 显卡型号（移除空格）
    ].join('|');
    
    console.log('机器信息组合:', stableMachineInfo);
    
    // 使用djb2哈希算法，确保结果稳定
    let hash = 5381;
    for (let i = 0; i < stableMachineInfo.length; i++) {
      hash = ((hash << 5) + hash) + stableMachineInfo.charCodeAt(i);
      hash = hash & hash; // 转换为32位整数
    }
    
    // 生成机器码，使用固定长度确保一致性
    const absHash = Math.abs(hash);
    const machineCode = 'DAS' + absHash.toString(36).toUpperCase().padStart(10, '0').substring(0, 10);
    
    console.log('生成机器码:', machineCode);
    console.log('机器信息详情:', {
      platform,
      screenInfo,
      timezone,
      systemLanguage,
      hardwareConcurrency,
      webglVendor: webglVendor.substring(0, 30),
      webglRenderer: webglRenderer.substring(0, 30),
      hash: absHash
    });
    
    return machineCode;
  } catch (error) {
    console.error('生成机器码失败:', error);
    
    // 降级方案：使用最基本但稳定的硬件信息
    const basicInfo = [
      navigator.platform,
      screen.width.toString(),
      screen.height.toString(),
      (navigator.hardwareConcurrency || 4).toString(),
      Intl.DateTimeFormat().resolvedOptions().timeZone
    ].join('|');
    
    let hash = 5381;
    for (let i = 0; i < basicInfo.length; i++) {
      hash = ((hash << 5) + hash) + basicInfo.charCodeAt(i);
      hash = hash & hash;
    }
    
    const fallbackCode = 'DAS' + Math.abs(hash).toString(36).toUpperCase().padStart(10, '0').substring(0, 10);
    
    console.log('使用降级机器码:', fallbackCode);
    console.log('降级信息:', basicInfo);
    
    return fallbackCode;
  }
}

// 保存认证状态
async function saveAuthState() {
  try {
    await chrome.storage.local.set({
      authState: {
        ...authState,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    console.error('保存认证状态失败:', error);
  }
}

// 恢复认证状态
async function restoreAuthState() {
  try {
    const data = await chrome.storage.local.get('authState');
    if (data.authState) {
      // 检查是否在24小时内
      const now = Date.now();
      const savedTime = data.authState.timestamp || 0;
      const hoursDiff = (now - savedTime) / (1000 * 60 * 60);
      
      if (hoursDiff < 24) {
        authState = { ...data.authState };
        delete authState.timestamp;
        
        // 验证token是否还有效
        if (authState.token && authState.vipExpTime) {
          const currentTime = Math.floor(Date.now() / 1000);
          if (currentTime < authState.vipExpTime) {
            return true; // 认证有效
          }
        }
      }
    }
  } catch (error) {
    console.error('恢复认证状态失败:', error);
  }
  return false;
}

// 显示认证状态
function showAuthStatus(message, type = 'info') {
  const statusDiv = document.getElementById('authStatus');
  const statusText = document.getElementById('authStatusText');
  
  if (statusDiv && statusText) {
    statusDiv.className = `auth-status ${type}`;
    statusText.textContent = message;
    statusDiv.style.display = 'block';
  }
}

// 隐藏认证状态
function hideAuthStatus() {
  const statusDiv = document.getElementById('authStatus');
  if (statusDiv) {
    statusDiv.style.display = 'none';
  }
}

// 切换界面显示
function switchToMainContent() {
  const authContainer = document.getElementById('authContainer');
  const mainContent = document.getElementById('mainContent');
  
  if (authContainer && mainContent) {
    authContainer.style.display = 'none';
    mainContent.classList.add('show');
  }
}

function switchToAuthContent() {
  const authContainer = document.getElementById('authContainer');
  const mainContent = document.getElementById('mainContent');
  
  if (authContainer && mainContent) {
    authContainer.style.display = 'flex';
    mainContent.classList.remove('show');
  }
}

// 卡密验证函数
async function verifyCardKey(cardKey) {
  try {
    // 测试模式：任意卡密都通过（正式环境需删除或设置为false）
    const TEST_MODE = true;
    if (TEST_MODE) {
      // 模拟验证成功
      authState.isAuthenticated = true;
      authState.token = 'test_token_' + Date.now();
      authState.cardNo = cardKey;
      // 设置一个未来的到期时间（7天后）
      authState.vipExpTime = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
      authState.cardKey = cardKey; // 保存卡密用于记忆功能和心跳检测
      await saveAuthState();

      // 保存卡密到本地存储（用于记忆功能）
      await chrome.storage.local.set({
        rememberedCardKey: cardKey
      });

      const expDate = new Date(authState.vipExpTime * 1000).toLocaleString();
      
      return {
        success: true,
        message: '测试模式：卡密验证成功',
        data: {
          cardNo: cardKey,
          vipExpTime: authState.vipExpTime,
          vipExpDate: expDate
        }
      };
    }

    // 生成或获取UDID（机器码）
    if (!authState.udid) {
      authState.udid = await generateUDID();
    }
    
    console.log('开始卡密验证:', {
      cardKey: cardKey.substring(0, 4) + '****',
      udid: authState.udid,
      apiUrl: AUTH_CONFIG.API_URL,
      userAgent: navigator.userAgent.substring(0, 50) + '...',
      platform: navigator.platform,
      screenSize: `${screen.width}x${screen.height}`
    });
    
    // 准备请求数据
    const formData = new FormData();
    formData.append('account', cardKey);
    formData.append('password', '');
    formData.append('udid', authState.udid);
    
    // 发送验证请求
    const response = await fetch(AUTH_CONFIG.API_URL, {
      method: 'POST',
      body: formData,
      headers: {
        'User-Agent': navigator.userAgent
      }
    });
    
    if (!response.ok) {
      throw new Error(`网络请求失败 ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    console.log('服务器响应:', result);
    
    if (result.code === 200) {
      // 解析返回数据
      const data = JSON.parse(result.data);
      console.log('解析的数据:', data);
      
      // 检查卡密是否到期（使用服务器时间和vipExpTime比较）
      const serverTime = result.time || Math.floor(Date.now() / 1000);
      if (data.info && data.info.vipExpTime && serverTime >= data.info.vipExpTime) {
        throw new Error('卡密已到期，请重新购买');
      }
      
      // 保存认证信息
      authState.isAuthenticated = true;
      authState.token = data.token;
      authState.cardNo = data.info ? data.info.cardNo : cardKey;
      authState.vipExpTime = data.info ? data.info.vipExpTime : null;
      authState.cardKey = cardKey; // 保存卡密用于记忆功能和心跳检测
      
      await saveAuthState();
      
      // 保存卡密到本地存储（用于记忆功能）
      await chrome.storage.local.set({
        rememberedCardKey: cardKey
      });
      
      const expDate = authState.vipExpTime ? 
        new Date(authState.vipExpTime * 1000).toLocaleString() : '永久';
      
      return {
        success: true,
        message: '验证成功',
        data: {
          cardNo: authState.cardNo,
          vipExpTime: authState.vipExpTime,
          vipExpDate: expDate
        }
      };
    } else {
      // 处理各种错误情况
      let errorMessage = result.msg || '验证失败';
      
      // 根据常见错误码提供更友好的提示
      if (errorMessage.includes('卡密不存在') || errorMessage.includes('账号不存在')) {
        errorMessage = '卡密不存在，请检查卡密是否正确';
      } else if (errorMessage.includes('已被登录') || errorMessage.includes('设备超限')) {
        errorMessage = '该卡密已在其他电脑登录，一个卡密只能在一台电脑上使用';
      } else if (errorMessage.includes('已到期') || errorMessage.includes('过期')) {
        errorMessage = '卡密已到期，请重新购买';
      } else if (errorMessage.includes('被禁用') || errorMessage.includes('封禁')) {
        errorMessage = '卡密已被禁用，请联系客服';
      }
      
      throw new Error(errorMessage);
    }
  } catch (error) {
    console.error('卡密验证失败:', error);
    return {
      success: false,
      message: error.message || '网络错误，请检查网络连接'
    };
  }
}

// 检查认证状态
async function checkAuthStatus() {
  try {
    const isAuthenticated = await restoreAuthState();
    
    if (isAuthenticated && authState.isAuthenticated) {
      // 显示认证信息
      const expDate = new Date(authState.vipExpTime * 1000);
      showAuthStatus(`认证成功！卡密：${authState.cardNo}，到期时间：${expDate.toLocaleString()}`, 'success');
      
      // 延迟切换到主界面
      setTimeout(() => {
        switchToMainContent();
        hideAuthStatus();
        // 启动定期认证检查
        startAuthCheck();
      }, 2000);
      
      return true;
    } else {
      // 显示登录界面
      switchToAuthContent();
      return false;
    }
  } catch (error) {
    console.error('检查认证状态失败:', error);
    switchToAuthContent();
    return false;
  }
}

// 初始化认证界面
async function initAuthInterface() {
  const authForm = document.getElementById('authForm');
  const cardKeyInput = document.getElementById('cardKey');
  const loginBtn = document.getElementById('loginBtn');
  const loginBtnText = document.getElementById('loginBtnText');
  const loginBtnLoading = document.getElementById('loginBtnLoading');
  
  // 恢复记忆的卡密
  try {
    const data = await chrome.storage.local.get('rememberedCardKey');
    if (data.rememberedCardKey && cardKeyInput) {
      cardKeyInput.value = data.rememberedCardKey;
      console.log('已恢复记忆的卡密');
    }
  } catch (error) {
    console.error('恢复卡密失败:', error);
  }
  
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const cardKey = cardKeyInput.value.trim();
      if (!cardKey) {
        showAuthStatus('请输入卡密', 'error');
        return;
      }
      
      // 显示加载状态
      loginBtn.disabled = true;
      loginBtnText.style.display = 'none';
      loginBtnLoading.style.display = 'inline';
      hideAuthStatus();
      
      try {
        const result = await verifyCardKey(cardKey);
        
        if (result.success) {
          const expDate = result.data.vipExpDate || '永久';
          showAuthStatus(`验证成功！卡密：${result.data.cardNo}，到期时间：${expDate}`, 'success');
          
          // 延迟切换到主界面
          setTimeout(() => {
            switchToMainContent();
            hideAuthStatus();
            // 启动定期认证检查和心跳检测
            startAuthCheck();
          }, 2000);
        } else {
          showAuthStatus(result.message, 'error');
        }
      } catch (error) {
        showAuthStatus('验证失败，请重试', 'error');
        console.error('验证异常:', error);
      } finally {
        // 恢复按钮状态
        loginBtn.disabled = false;
        loginBtnText.style.display = 'inline';
        loginBtnLoading.style.display = 'none';
      }
    });
  }
}

// 心跳检测 - 定期验证卡密状态
async function performHeartbeat() {
  if (!authState.isAuthenticated || !authState.cardKey) {
    return;
  }
  
  try {
    console.log('执行心跳检测...');
    
    // 使用保存的卡密重新验证
    const result = await verifyCardKey(authState.cardKey);
    
    if (!result.success) {
      console.log('心跳检测失败:', result.message);
      
      // 如果验证失败，清除认证状态
      authState.isAuthenticated = false;
      await chrome.storage.local.remove(['authState', 'rememberedCardKey']);
      
      // 切换到认证界面
      switchToAuthContent();
      showAuthStatus(`认证失效: ${result.message}`, 'error');
      
      addLog(`心跳检测失败: ${result.message}`, 'error');
    } else {
      console.log('心跳检测成功');
      addLog('心跳检测通过', 'success');
    }
  } catch (error) {
    console.error('心跳检测异常:', error);
    addLog(`心跳检测异常: ${error.message}`, 'warning');
  }
}

// 定期检查认证状态和心跳检测
function startAuthCheck() {
  // 每3分钟进行一次心跳检测
  setInterval(async () => {
    if (authState.isAuthenticated) {
      // 首先检查本地到期时间
      if (authState.vipExpTime) {
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime >= authState.vipExpTime) {
          // 卡密已到期
          addLog('卡密已到期，请重新验证', 'error');
          authState.isAuthenticated = false;
          await chrome.storage.local.remove(['authState', 'rememberedCardKey']);
          switchToAuthContent();
          showAuthStatus('卡密已到期，请重新验证', 'error');
          return;
        }
      }
      
      // 执行心跳检测
      await performHeartbeat();
    }
  }, 3 * 60 * 1000); // 3分钟检查一次
  
  // 每30秒检查一次本地到期时间（轻量级检查）
  setInterval(async () => {
    if (authState.isAuthenticated && authState.vipExpTime) {
      const currentTime = Math.floor(Date.now() / 1000);
      if (currentTime >= authState.vipExpTime) {
        addLog('卡密已到期，请重新验证', 'error');
        authState.isAuthenticated = false;
        await chrome.storage.local.remove(['authState', 'rememberedCardKey']);
        switchToAuthContent();
        showAuthStatus('卡密已到期，请重新验证', 'error');
      }
    }
  }, 30 * 1000); // 30秒检查一次
}

// 修改笔记数据存储，改为动态数组
let notes = [];
let isPublishing = false;

// 在文件开头添加图片数组用于跟踪顺序
let selectedImages = [];
let imagePreviewUrls = {};

// 修改发布配置对象
const publishConfig = {
  intervalType: 'fixed', // 'fixed' 或 'random'
  fixedInterval: 300,    // 默认5分钟
  minInterval: 300,      // 默认最小5分钟
  maxInterval: 600,      // 默认最大10分钟
};

// 添加倒计时状态
let countdownTimers = [];

// 在文件开头添加状态保存和恢复函数
async function saveState() {
  try {
    const state = {
      notes,
      publishConfig,
      isPublishing
    };
    await chrome.storage.local.set({ popupState: state });
  } catch (error) {
    console.error('保存状态失败:', error);
  }
}

async function restoreState() {
  try {
    const data = await chrome.storage.local.get(['popupState', 'publishState']);
    
    // 恢复 popup 状态
    if (data.popupState) {
      notes = data.popupState.notes;
      publishConfig = data.popupState.publishConfig;
      isPublishing = data.popupState.isPublishing;
      
      // 更新界面
      updateNotePanels();
      
      // 恢复发布设置
      const intervalTypeInputs = document.querySelectorAll('input[name="intervalType"]');
      intervalTypeInputs.forEach(input => {
        if (input.value === publishConfig.intervalType) {
          input.checked = true;
          // 触发change事件以显示/隐藏相应的设置项
          input.dispatchEvent(new Event('change'));
        }
      });
      
      document.getElementById('fixedInterval').value = publishConfig.fixedInterval / 60;
      document.getElementById('minInterval').value = publishConfig.minInterval / 60;
      document.getElementById('maxInterval').value = publishConfig.maxInterval / 60;
    }

    // 检查是否正在发布
    if (data.publishState && data.publishState.isPublishing) {
      isPublishing = true;
      addLog('发布任务正在后台运行中...', 'info');
    }
  } catch (error) {
    console.error('恢复状态失败:', error);
  }
}

// 在文件中添加状态变化监听
function setupStateListeners() {
  // 监听笔记内容变化
  const observer = new MutationObserver(() => {
    saveState();
  });

  // 监听设置变化
  const intervalTypeInputs = document.querySelectorAll('input[name="intervalType"]');
  intervalTypeInputs.forEach(input => {
    input.addEventListener('change', saveState);
  });

  document.getElementById('fixedInterval').addEventListener('change', saveState);
  document.getElementById('minInterval').addEventListener('change', saveState);
  document.getElementById('maxInterval').addEventListener('change', saveState);
}

// 改进日志函数
function addLog(message, type = 'info', details = '') {
  const logData = {
    time: new Date().toLocaleTimeString(),
    message,
    type,
    details
  };

  // 保存日志到 storage
  chrome.storage.local.get('logs', (data) => {
    const logs = data.logs || [];
    logs.push(logData);
    // 只保留最近的 100 条日志
    if (logs.length > 100) {
      logs.shift();
    }
    chrome.storage.local.set({ logs });
  });

  // 显示日志
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

// 等待页面加载完成
document.addEventListener('DOMContentLoaded', async () => {
  console.log('页面加载完成');
  
  // 添加机器码测试按钮
  const machineCodeTestBtn = document.createElement('button');
  machineCodeTestBtn.textContent = '测试机器码';
  machineCodeTestBtn.style.cssText = 'margin: 5px; padding: 5px 10px; background: #28a745; color: white; border: none; border-radius: 3px; cursor: pointer;';
  machineCodeTestBtn.onclick = async () => {
    try {
      const udid = await generateUDID();
      addLog('=== 机器码测试结果 ===', 'info');
      addLog(`当前机器码: ${udid}`, 'success');
      addLog(`浏览器: ${navigator.userAgent.split(' ')[0]}`, 'info');
      addLog(`平台: ${navigator.platform}`, 'info');
      addLog(`屏幕: ${screen.width}x${screen.height}`, 'info');
      addLog(`CPU核心: ${navigator.hardwareConcurrency}`, 'info');
      addLog(`时区: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`, 'info');
      addLog('请在不同浏览器中运行此测试，确认机器码一致', 'warning');
    } catch (error) {
      addLog(`机器码测试失败: ${error.message}`, 'error');
    }
  };
  
  // 添加调试按钮
  const debugBtn = document.createElement('button');
  debugBtn.textContent = '调试上传元素';
  debugBtn.style.cssText = 'margin: 5px; padding: 5px 10px; background: #007bff; color: white; border: none; border-radius: 3px; cursor: pointer;';
  debugBtn.onclick = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab.url.includes('creator.xiaohongshu.com')) {
        addLog('请先打开小红书创作者后台页面', 'error');
        return;
      }
      
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        function: () => {
          const selectors = [
            '#web > div > div > div > div.upload-content.hasBannerHeight > div.upload-wrapper > div > input',
            '#web > div > div > div > div.upload-content > div.upload-wrapper > div > input',
            '#web > div.outarea.upload-c > div > div > div.upload-content > div.upload-wrapper > div > input',
            'input[data-v-4506f808][data-v-7cbccdb2-s].upload-input[type="file"][multiple][accept*=".jpg"]',
            '.upload-input[type="file"]',
            'input[type="file"][multiple][accept*=".jpg"]',
            'input[type="file"][accept*="image"]'
          ];
          
          const results = [];
          selectors.forEach((selector, index) => {
            const element = document.querySelector(selector);
            results.push({
              index: index + 1,
              selector,
              found: !!element,
              attributes: element ? {
                type: element.type,
                accept: element.accept,
                multiple: element.multiple,
                className: element.className,
                id: element.id
              } : null
            });
          });
          
          return {
            url: window.location.href,
            results,
            allInputs: Array.from(document.querySelectorAll('input[type="file"]')).map(input => ({
              selector: input.tagName.toLowerCase() + (input.id ? '#' + input.id : '') + (input.className ? '.' + input.className.split(' ').join('.') : ''),
              attributes: {
                type: input.type,
                accept: input.accept,
                multiple: input.multiple,
                className: input.className,
                id: input.id
              }
            }))
          };
        }
      });
      
      const data = result[0].result;
      addLog('=== 上传元素调试信息 ===', 'info');
      addLog(`当前页面: ${data.url}`, 'info');
      addLog('', 'info');
      
      data.results.forEach(item => {
        const status = item.found ? '✅ 找到' : '❌ 未找到';
        addLog(`${item.index}. ${status}`, item.found ? 'success' : 'error');
        addLog(`   选择器: ${item.selector}`, 'info');
        if (item.found && item.attributes) {
          addLog(`   属性: ${JSON.stringify(item.attributes)}`, 'info');
        }
        addLog('', 'info');
      });
      
      if (data.allInputs.length > 0) {
        addLog('=== 页面中所有文件输入框 ===', 'info');
        data.allInputs.forEach((input, index) => {
          addLog(`${index + 1}. ${input.selector}`, 'info');
          addLog(`   属性: ${JSON.stringify(input.attributes)}`, 'info');
        });
      } else {
        addLog('页面中没有找到任何文件输入框', 'warning');
      }
      
    } catch (error) {
      addLog(`调试失败: ${error.message}`, 'error');
    }
  };
  
  // 将调试按钮添加到控制面板
  const controlPanel = document.querySelector('.control-panel');
  if (controlPanel) {
    controlPanel.appendChild(machineCodeTestBtn);
    controlPanel.appendChild(debugBtn);
  } else {
    // 如果没有控制面板，添加到主界面
    const mainContent = document.getElementById('mainContent');
    if (mainContent) {
      const buttonContainer = document.createElement('div');
      buttonContainer.style.cssText = 'margin: 10px 0; text-align: center;';
      buttonContainer.appendChild(machineCodeTestBtn);
      buttonContainer.appendChild(debugBtn);
      mainContent.appendChild(buttonContainer);
    }
  }
  
  // 初始化认证界面
  initAuthInterface();
  
  // 检查认证状态
  const isAuthenticated = await checkAuthStatus();
  
  if (!isAuthenticated) {
    // 如果未认证，只初始化认证界面，不加载主功能
    return;
  }
  
  // 认证成功，初始化主功能
  await restoreState();
  setupStateListeners();

  // 选择文件按钮
  const fileInput = document.getElementById('fileInput');
  const readFileBtn = document.getElementById('readFile');
  const startButton = document.getElementById('startButton');
  
  if (readFileBtn && fileInput) {
    console.log('找到文件按钮');
    readFileBtn.addEventListener('click', () => {
      console.log('点击选择文件');
      fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', async function() {
      if (this.files.length === 0) return;
      const file = this.files[0];
      
      addLog(`开始读取文件: ${file.name} (${file.size} 字节)`, 'info');
      
      try {
        // 检查文件类型
        const fileName = file.name.toLowerCase();
        const isExcelFile = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
        const isCsvFile = fileName.endsWith('.csv');
        
        if (isExcelFile) {
          addLog('检测到Excel文件', 'info');
          addLog('正在读取Excel文件内容...', 'info');
          
          try {
            if (typeof XLSX === 'undefined') {
              addLog('SheetJS 库未加载，请检查网络连接后重试', 'error');
              return;
            }
            if (typeof JSZip === 'undefined') {
              addLog('JSZip 库未加载，将无法提取嵌入图片', 'warning');
            }

            const arrayBuffer = await file.arrayBuffer();

            // === 步骤 1：SheetJS 读取文字数据 ===
            addLog('步骤1: 使用 SheetJS 解析单元格文字数据...', 'info');
            const workbook = XLSX.read(arrayBuffer, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            
            if (jsonData.length < 2) {
              addLog('Excel 至少需要标题行和一行数据', 'error');
              return;
            }

            // 解析表头
            const header = jsonData[0].map(h => (h || '').toString().trim());
            addLog(`Excel 表头: ${header.join(', ')}`, 'info');

            const idx = {
              image: header.findIndex(h => h.includes('主图') || h.includes('封面')),
              productId: header.findIndex(h => h.includes('商品ID') || h.includes('商品id')),
              title: header.findIndex(h => h.includes('标题')),
              body: header.findIndex(h => h.includes('正文')),
              tags: header.findIndex(h => h.includes('标签'))
            };

            // 动态收集所有"内页图"列（不限数量）
            const innerImageCols = [];
            header.forEach((h, colIdx) => {
              if (/内页/.test(h)) {
                innerImageCols.push(colIdx);
              }
            });
            // 按列索引排序，确保内页图1在内页图2前面
            innerImageCols.sort((a, b) => a - b);
            addLog(`封面列=${idx.image}, 内页图列=[${innerImageCols.join(',')}] (共${innerImageCols.length}列)`, 'info');

            if (idx.title === -1) {
              addLog('Excel 缺少"标题"列', 'error');
              return;
            }

            addLog(`字段索引: 封面/主图=${idx.image}, 商品ID=${idx.productId}, 标题=${idx.title}, 正文=${idx.body}, 标签=${idx.tags}`, 'info');

            // === 步骤 2：JSZip 提取嵌入图片 ===
            let embeddedImages = {};
            if (typeof JSZip !== 'undefined' && fileName.endsWith('.xlsx')) {
              addLog('步骤2: 使用 JSZip 从 xlsx ZIP 结构中提取嵌入图片...', 'info');
              try {
                const zip = await JSZip.loadAsync(arrayBuffer);
                embeddedImages = await extractExcelImages(zip);
                const embeddedCount = Object.values(embeddedImages).reduce((s, a) => s + a.length, 0);
                addLog(`从 Excel 中提取到 ${embeddedCount} 张嵌入图片`, 'success');
              } catch (zipError) {
                addLog(`JSZip 解析失败: ${zipError.message}，将忽略嵌入图片`, 'warning');
              }
            } else if (fileName.endsWith('.xls')) {
              addLog('.xls 格式不支持提取嵌入图片（非 ZIP 结构），仅读取文字', 'warning');
            }

            // === 步骤 3：组装笔记数据 ===
            addLog('步骤3: 合并文字数据和图片，生成笔记...', 'info');
            const notesArr = [];

            for (let i = 1; i < jsonData.length; i++) {
              const row = jsonData[i];
              if (!row || row.length === 0) continue;

              const getVal = (index) => {
                return index >= 0 && index < row.length ? (row[index] || '').toString().trim() : '';
              };

              // 标题
              const title = getVal(idx.title);
              if (!title) {
                addLog(`跳过第 ${i + 1} 行: 标题为空`, 'warning');
                continue;
              }

              // 正文
              const body = getVal(idx.body);

              // 标签
              let tags = [];
              const tagsStr = getVal(idx.tags);
              if (tagsStr) {
                tags = tagsStr.split(/[#\s,，]+/).filter(Boolean).map(t => '#' + t.replace(/^#/, ''));
              }

              // 商品ID
              const productId = getVal(idx.productId);

              // 图片处理：优先使用嵌入图片，其次使用主图链接列
              const note = {
                title,
                body,
                tags,
                productId,
                images: [],
                imageUrls: {}
              };

              // 嵌入图片（i 是 1-based 数据行索引，对应 drawing 中 0-based 的 rowIndex=i）
              const rowEmbeddedImages = embeddedImages[i] || [];
              if (rowEmbeddedImages.length > 0) {
                addLog(`第 ${i + 1} 行匹配到 ${rowEmbeddedImages.length} 张嵌入图片`, 'success');
                rowEmbeddedImages.forEach((dataUrl, j) => {
                  // 将 base64 转为 Blob 用于上传
                  try {
                    const byteString = atob(dataUrl.split(',')[1]);
                    const mimeString = dataUrl.split(',')[0].split(':')[1].split(';')[0];
                    const ab = new ArrayBuffer(byteString.length);
                    const ia = new Uint8Array(ab);
                    for (let k = 0; k < byteString.length; k++) {
                      ia[k] = byteString.charCodeAt(k);
                    }
                    const blob = new Blob([ab], { type: mimeString });
                    note.images.push(blob);
                    note.imageUrls[j] = dataUrl;
                  } catch (e) {
                    addLog(`嵌入图片转换失败: ${e.message}`, 'warning');
                  }
                });
              }

              // 如果没有嵌入图片，尝试从封面列+所有内页图列下载图片链接
              if (note.images.length === 0) {
                // 收集所有图片列：封面 + 内页图1~N
                const allImageCols = [];
                if (idx.image >= 0) allImageCols.push(idx.image);
                allImageCols.push(...innerImageCols);

                for (const colIdx of allImageCols) {
                  const cellValue = getVal(colIdx);
                  if (!cellValue) continue;

                  // 支持单元格内多个链接（换行/逗号分隔）
                  const imageLinks = cellValue
                    .split(/[\n\r,，]/)
                    .map(s => s.trim())
                    .filter(s => s && (s.startsWith('http://') || s.startsWith('https://')))
                    .map(s => s.replace(/[""]/g, ''));

                  for (let j = 0; j < imageLinks.length; j++) {
                    try {
                      addLog(`第 ${i + 1} 行下载图片: ${imageLinks[j]}`, 'info');
                      const res = await fetch(imageLinks[j]);
                      const blob = await res.blob();
                      const dataUrl = await new Promise(resolve => {
                        const reader = new FileReader();
                        reader.onload = e => resolve(e.target.result);
                        reader.readAsDataURL(blob);
                      });
                      note.images.push(blob);
                      note.imageUrls[note.images.length - 1] = dataUrl;
                      addLog(`图片下载成功: ${imageLinks[j]}`, 'success');
                    } catch (e) {
                      addLog(`图片下载失败: ${imageLinks[j]} - ${e.message}`, 'error');
                    }
                  }
                }
              }

              notesArr.push(note);
              addLog(`第 ${i + 1} 行解析完成: ${title} (${note.images.length} 张图片)`, 'info');
            }

            notes = notesArr;
            updateNotePanels();
            addLog(`成功导入 ${notes.length} 篇笔记（Excel），共 ${notes.reduce((s, n) => s + n.images.length, 0)} 张图片`, 'success');
            return;

          } catch (excelError) {
            addLog(`Excel 文件处理失败: ${excelError.message}`, 'error');
            console.error('Excel 处理错误:', excelError);
            addLog('请确保文件格式正确，或另存为 CSV 格式后重试', 'info');
            return;
          }
        }
        
        const text = await file.text();
        addLog(`文件读取成功，内容长度: ${text.length} 字符`, 'info');
        
        // 检查是否为CSV格式
        let isCsv = isCsvFile || text.startsWith('主图链接,') || text.includes(',') && text.includes('\n');
        
        if (isCsv) {
          addLog('检测到CSV格式，开始解析...', 'info');
          // CSV导入
          notes = await parseCsvNotes(text);
          updateNotePanels();
          addLog(`成功导入 ${notes.length} 篇笔记（CSV表格）`, 'success');
        } else {
          addLog('检测到TXT格式，开始解析...', 'info');
          // TXT导入
          const noteContents = text.split(/\-{5,}/).map(content => content.trim()).filter(Boolean);
          notes = noteContents.map(content => {
            const noteData = parseNoteContent(content);
            return { ...noteData, images: [], imageUrls: {} };
          });
          updateNotePanels();
          addLog(`成功导入 ${notes.length} 篇笔记`, 'success');
        }
      } catch (error) {
        addLog(`读取文件失败: ${error.message}`, 'error');
        addLog('请检查文件格式是否正确，建议使用UTF-8编码的CSV文件', 'info');
        console.error('文件读取错误详情:', error);
      }
    });
  }

  // 为每个笔记面板添加图片处理功能
  document.querySelectorAll('.note-panel').forEach((panel, index) => {
    const imageInput = panel.querySelector('.image-input');
    const selectImageBtn = panel.querySelector('.select-image');
    const clearImagesBtn = panel.querySelector('.clear-images');
    const imagePreview = panel.querySelector('.image-preview');

    // 选择图片按钮点击事件
    selectImageBtn.addEventListener('click', () => {
      imageInput.click();
    });

    // 图片选择处理
    imageInput.onchange = async function() {
      if (this.files.length === 0) return;

      const files = Array.from(this.files);
      addLog(`选择了 ${files.length} 张图片`);
      
      try {
        // 加载所有图片
        const loadedImages = await Promise.all(files.map((file, i) => {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve({
              index: i,
              file,
              dataUrl: e.target.result
            });
            reader.readAsDataURL(file);
          });
        }));
        
        // 清空当前笔记的图片（移到这里，确保新图片加载成功后再清空）
        notes[index].images = [];
        notes[index].imageUrls = {};
        imagePreview.innerHTML = '';
        
        // 处理加载的图片
        loadedImages.forEach((imageData, i) => {
          // 保存图片数据
          notes[index].images[i] = imageData.file;
          notes[index].imageUrls[i] = imageData.dataUrl;
          
          // 创建并添加预览元素
          const wrapper = createImagePreview({
            index: i,
            file: imageData.file,
            dataUrl: imageData.dataUrl
          }, panel, index);
          
          // 确保 imagePreview 存在
          if (!imagePreview.isConnected) {
            panel.querySelector('.image-preview').appendChild(wrapper);
          } else {
            imagePreview.appendChild(wrapper);
          }
          
          addLog(`已加载第 ${i + 1} 张图片`);
        });

        // 保存图片数据到本地存储
        try {
          const noteImages = {
            images: notes[index].images,
            imageUrls: notes[index].imageUrls
          };
          localStorage.setItem(`note_${index}_images`, JSON.stringify(noteImages));
        } catch (error) {
          console.error('保存图片数据失败:', error);
        }

        addLog(`共加载 ${loadedImages.length} 张图片`, 'success');
      } catch (error) {
        addLog(`加载图片失败: ${error.message}`, 'error');
      }
    };

    // 清除图片按钮点击事件
    clearImagesBtn.addEventListener('click', () => {
      notes[index].images = [];
      notes[index].imageUrls = {};
      imagePreview.innerHTML = '';
      imageInput.value = ''; // 重置文件输入框
      addLog('已清除所有图片');
    });
  });

  // 获取设置控件
  const intervalTypeInputs = document.querySelectorAll('input[name="intervalType"]');
  const fixedIntervalInput = document.getElementById('fixedInterval');
  const minIntervalInput = document.getElementById('minInterval');
  const maxIntervalInput = document.getElementById('maxInterval');
  const fixedIntervalDiv = document.querySelector('.fixed-interval');
  const randomIntervalDiv = document.querySelector('.random-interval');

  // 处理间隔类型切换
  intervalTypeInputs.forEach(input => {
    input.addEventListener('change', (e) => {
      publishConfig.intervalType = e.target.value;
      if (e.target.value === 'fixed') {
        fixedIntervalDiv.style.display = 'block';
        randomIntervalDiv.style.display = 'none';
      } else {
        fixedIntervalDiv.style.display = 'none';
        randomIntervalDiv.style.display = 'block';
      }
    });
  });

  // 处理固定间隔输入
  fixedIntervalInput.addEventListener('change', () => {
    publishConfig.fixedInterval = parseInt(fixedIntervalInput.value) * 60;
  });

  // 处理随机间隔范围输入
  minIntervalInput.addEventListener('change', () => {
    publishConfig.minInterval = parseInt(minIntervalInput.value) * 60;
  });

  maxIntervalInput.addEventListener('change', () => {
    publishConfig.maxInterval = parseInt(maxIntervalInput.value) * 60;
  });

  // 开始运行按钮
  if (startButton) {
    console.log('找到开始运行按钮');
    startButton.onclick = async () => {
      // 检查认证状态
      if (!authState.isAuthenticated) {
        addLog('请先进行卡密验证', 'error');
        return;
      }
      
      // 检查卡密是否到期
      if (authState.vipExpTime) {
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime >= authState.vipExpTime) {
          addLog('卡密已到期，请重新验证', 'error');
          // 清除认证状态
          authState.isAuthenticated = false;
          await chrome.storage.local.remove('authState');
          switchToAuthContent();
          return;
        }
      }
      try {
        // 获取当前状态
        const response = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
            resolve(response || { isPublishing: false });
          });
        });

        if (response.isPublishing) {
          addLog('正在发布中，请等待...', 'info');
          return;
        }

        // 获取起始行号，截取从该行开始的笔记
        const startRow = parseInt(document.getElementById('startRow').value) || 1;
        const slicedNotes = notes.slice(startRow - 1);

        if (slicedNotes.length === 0) {
          addLog(`起始行 ${startRow} 超出笔记总数 ${notes.length}，请调整`, 'error');
          return;
        }

        // 检查笔记内容（只检查要发布的笔记）
        for (let i = 0; i < slicedNotes.length; i++) {
          if (!slicedNotes[i].title || slicedNotes[i].images.length === 0) {
            addLog(`第${startRow + i}篇笔记缺少标题或图片`, 'error');
            return;
          }
        }

        addLog(`从第 ${startRow} 行开始，共发布 ${slicedNotes.length} 篇笔记`, 'info');

        // 发送开始发布消息
        const publishResponse = await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'START_PUBLISH',
            data: {
              notes: slicedNotes,
              publishConfig: publishConfig
            }
          }, (response) => {
            resolve(response);
          });
        });
        
        // 检查认证错误
        if (publishResponse && publishResponse.error) {
          if (publishResponse.error.includes('未认证') || publishResponse.error.includes('卡密已到期')) {
            addLog(publishResponse.error, 'error');
            // 清除认证状态并切换到认证界面
            authState.isAuthenticated = false;
            await chrome.storage.local.remove('authState');
            switchToAuthContent();
            return;
          }
        }

        isPublishing = true;
        addLog('开始发布笔记...', 'info');
        startStatusUpdates();

      } catch (error) {
        addLog(`启动发布失败: ${error.message}`, 'error');
      }
    };

    // 添加点击效果
    startButton.addEventListener('mousedown', () => {
      startButton.style.transform = 'scale(0.98)';
    });

    startButton.addEventListener('mouseup', () => {
      startButton.style.transform = 'scale(1)';
    });

    // 添加悬停效果
    startButton.addEventListener('mouseover', () => {
      startButton.style.opacity = '0.9';
    });

    startButton.addEventListener('mouseout', () => {
      startButton.style.opacity = '1';
      startButton.style.transform = 'scale(1)';
    });
  }

  // 关闭按钮
  const closeBtn = document.querySelector('.close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }

  // 帮助按钮点击事件
  const helpBtn = document.querySelector('.help-btn');
  helpBtn.onclick = () => {
    window.open('help.html', '_blank');
  };

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'NOTE_PUBLISHED':
        addLog(`第${message.data.index + 1}篇笔记发布完成`, 'success');
        break;
      case 'WAITING':
        const waitMinutes = Math.floor(message.data.waitTime / 60);
        const waitSeconds = message.data.waitTime % 60;
        addLog(`等待发布第${message.data.nextIndex + 1}篇笔记...`, 'info',
          `等待时间: ${waitMinutes}分${waitSeconds}秒`);
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
    }
  });

  // 检查是否正在发布，如果是则启动状态更新
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
    if (state.isPublishing) {
      isPublishing = true;
      addLog('发布任务正在进行中...', 'info');
      startStatusUpdates();
    }
  } catch (error) {
    console.error('检查发布状态失败:', error);
  }

  setupMessageListener();
  
  // 恢复之前的状态
  chrome.storage.local.get(['pState'], (result) => {
    if (result.pState) {
      const state = {
        isPublishing: result.pState.i,
        currentIndex: result.pState.c,
        totalNotes: result.pState.t,
        currentAction: result.pState.a,
        waitTime: result.pState.w
      };
      updateStatusDisplay(state);
    }
  });

  // 清空按钮功能
  const clearAllButton = document.getElementById('clearAllButton');
  if (clearAllButton) {
    clearAllButton.onclick = async () => {
      if (!confirm('确定要清空当天所有发布内容吗？此操作不可恢复！')) return;
      // 主动通知后台终止发布
      try {
        await chrome.runtime.sendMessage({ type: 'STOP_PUBLISH' });
      } catch (e) {}
      // 清空所有笔记、图片、状态
      notes = [];
      isPublishing = false;
      // 清空本地存储相关内容
      try {
        await chrome.storage.local.remove(['popupState', 'logs']);
        // 清空所有note图片
        for (let i = 0; i < 100; i++) {
          await chrome.storage.local.remove(`note_${i}_images`);
          localStorage.removeItem(`note_${i}_images`);
        }
      } catch (e) {}
      // 清空内存图片
      for (let i = 0; i < 100; i++) {
        localStorage.removeItem(`note_${i}_images`);
      }
      updateNotePanels();
      const logPanel = document.getElementById('logPanel');
      if (logPanel) logPanel.innerHTML = '';
      addLog('已清空当天所有发布内容，请重新导入！', 'error');
    };
  }
});

function switchTab(selector) {
  // 1. 找到所有的tab元素
  const allTabs = document.querySelectorAll('.creator-tab');
  
  // 2. 移除所有tab的active类
  allTabs.forEach(tab => {
    tab.classList.remove('active');
  });
  
  // 3. 给目标元素添加active类
  const targetTab = document.querySelector(selector);
  if (targetTab) {
    targetTab.classList.add('active');
    addLog('已切换到目标标签', 'success');
  } else {
    addLog('未找到目标标签', 'error');
  }
}

function triggerElementClick(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    console.log('未找到元素:', selector);
    return;
  }

  console.log('找到元素:', selector);

  // 方法1: 原生click()
  element.click();
  
  // 方法2: 模拟鼠标事件序列
  const events = [
    'mousedown',
    'mouseup',
    'click'
  ];

  events.forEach(eventName => {
    const event = new MouseEvent(eventName, {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: element.getBoundingClientRect().left + 5,
      clientY: element.getBoundingClientRect().top + 5
    });
    element.dispatchEvent(event);
  });

  // 方法3: 触发所有可能的事件
  [
    new MouseEvent('mouseover', { bubbles: true }),
    new MouseEvent('mouseenter', { bubbles: true }),
    new MouseEvent('mousedown', { bubbles: true }),
    new MouseEvent('mouseup', { bubbles: true }),
    new MouseEvent('click', { bubbles: true }),
    new Event('focus', { bubbles: true }),
    new KeyboardEvent('keydown', { bubbles: true }),
    new KeyboardEvent('keyup', { bubbles: true }),
    new KeyboardEvent('keypress', { bubbles: true })
  ].forEach(event => element.dispatchEvent(event));

  // 方法4: 直接执行元素上的onclick函数
  if (typeof element.onclick === 'function') {
    element.onclick();
  }

  // 方法5: 查找并触发父元素的点击事件
  let parent = element.parentElement;
  while (parent) {
    if (typeof parent.onclick === 'function') {
      parent.onclick();
    }
    parent = parent.parentElement;
  }

  // 输出元素的所有属性和事件处理器
  console.log('元素属性:', {
    id: element.id,
    className: element.className,
    style: element.style.cssText,
    onclick: element.onclick,
    dataset: element.dataset,
    attributes: Array.from(element.attributes).map(attr => ({
      name: attr.name,
      value: attr.value
    }))
  });
}

function simulateRealClick(selector) {
  const element = document.querySelector(selector);
  if (!element) return;

  const rect = element.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  const options = {
    bubbles: true,
    cancelable: true,
    view: window,
    detail: 1,
    screenX: centerX + window.screenX,
    screenY: centerY + window.screenY,
    clientX: centerX,
    clientY: centerY,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    button: 0,
    relatedTarget: null
  };

  element.dispatchEvent(new MouseEvent('mouseover', options));
  element.dispatchEvent(new MouseEvent('mouseenter', options));
  element.dispatchEvent(new MouseEvent('mousedown', options));
  element.dispatchEvent(new MouseEvent('mouseup', options));
  element.dispatchEvent(new MouseEvent('click', options));

  if (element.focus) {
    element.focus();
  }
}

// 修改图片预览创建函数
function createImagePreview(imageData, index, panel, noteIndex) {
  const wrapper = document.createElement('div');
  wrapper.className = 'preview-image-wrapper';
  wrapper.dataset.index = index;
  wrapper.draggable = true;

  // 创建图片容器
  const imgContainer = document.createElement('div');
  imgContainer.style.width = '100%';
  imgContainer.style.height = '100%';
  imgContainer.style.position = 'relative';

  // 创建图片元素
  const img = document.createElement('img');
  img.src = imageData.dataUrl;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'cover';
  
  // 创建序号标签
  const indexLabel = document.createElement('div');
  indexLabel.className = 'image-index';
  indexLabel.textContent = (index + 1).toString();
  
  // 创建删除按钮
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-image';
  deleteBtn.innerHTML = '×';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    addLogToPanel(panel, `正在删除第 ${index + 1} 张图片...`);
    wrapper.remove();
    delete notes[noteIndex].images[index];
    delete notes[noteIndex].imageUrls[index];
    updateNoteImageIndices(panel, noteIndex);
    addLogToPanel(panel, `已删除第 ${index + 1} 张图片`, 'success');
  };

  // 修改拖拽事件处理
  wrapper.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    wrapper.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
    addLog(`开始拖动第 ${index + 1} 张图片`);
  });

  wrapper.addEventListener('dragend', () => {
    wrapper.classList.remove('dragging');
  });

  // 添加拖拽目标事件
  wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    
    const draggingElement = document.querySelector('.dragging');
    if (!draggingElement || draggingElement === wrapper) return;

    const imagePreview = panel.querySelector('.image-preview');
    const allWrappers = [...imagePreview.children];
    const draggingIndex = allWrappers.indexOf(draggingElement);
    const currentIndex = allWrappers.indexOf(wrapper);

    if (draggingIndex < currentIndex) {
      wrapper.after(draggingElement);
    } else {
      wrapper.before(draggingElement);
    }
  });

  // 将drop事件绑定到图片预览容器上
  const imagePreview = panel.querySelector('.image-preview');
  if (!imagePreview.hasDropHandler) {
    imagePreview.addEventListener('drop', (e) => {
      e.preventDefault();
      const draggingElement = document.querySelector('.dragging');
      if (!draggingElement) return;

      // 获取拖动前后的索引
      const allWrappers = [...imagePreview.children];
      const oldIndex = parseInt(draggingElement.dataset.index);
      const newIndex = allWrappers.indexOf(draggingElement);

      // 只有位置真的改变了才更新
      if (oldIndex !== newIndex) {
        updateNoteImageIndices(panel, noteIndex);
        addLog(`已将第 ${oldIndex + 1} 张图片移动到第 ${newIndex + 1} 位`, 'success');
      }
    });
    imagePreview.hasDropHandler = true;
  }

  imgContainer.appendChild(img);
  wrapper.appendChild(imgContainer);
  wrapper.appendChild(indexLabel);
  wrapper.appendChild(deleteBtn);
  return wrapper;
}

// 修改更新图片索引的函数
function updateNoteImageIndices(panel, noteIndex) {
  const imagePreview = panel.querySelector('.image-preview');
  const wrappers = [...imagePreview.children];
  const newImages = [];
  const newImageUrls = {};
  
  wrappers.forEach((wrapper, newIndex) => {
    const oldIndex = parseInt(wrapper.dataset.index);
    
    // 更新DOM中的索引
    wrapper.dataset.index = newIndex;
    const indexLabel = wrapper.querySelector('.image-index');
    if (indexLabel) {
      indexLabel.textContent = (newIndex + 1).toString();
    }
    
    // 更新数据
    if (notes[noteIndex].images[oldIndex]) {
      newImages[newIndex] = notes[noteIndex].images[oldIndex];
      newImageUrls[newIndex] = notes[noteIndex].imageUrls[oldIndex];
    }
  });
  
  // 更新笔记对象中的图片数据
  notes[noteIndex].images = newImages.filter(Boolean);
  notes[noteIndex].imageUrls = Object.fromEntries(
    Object.entries(newImageUrls).filter(([_, v]) => v)
  );

  // 保存更新后的图片数据
  try {
    const noteImages = {
      images: notes[noteIndex].images,
      imageUrls: notes[noteIndex].imageUrls
    };
    localStorage.setItem(`note_${noteIndex}_images`, JSON.stringify(noteImages));
  } catch (error) {
    console.error('保存图片数据失败:', error);
    addLog('保存图片顺序失败', 'error');
  }
}

// 修改解析笔记内容的函数
function parseNoteContent(text) {
  try {
    // 按行分割，保留所有空行
    const lines = text.split('\n');
    
    // 获取标题（第一行）
    const title = lines[0].trim();
    
    // 初始化变量
    let body = [];
    let tags = [];
    let productId = '';
    let isBody = true;
    let hasStartedBody = false;
    
    // 从第二行开始遍历
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();
      
      // 检查是否是标签行（包含#号的行）
      if (trimmedLine.includes('#')) {
        isBody = false; // 标记已经不是正文部分
        // 匹配所有标签，包括中文
        const tagMatches = trimmedLine.match(/#[\u4e00-\u9fa5a-zA-Z0-9]+/g);
        if (tagMatches) {
          tags = tags.concat(tagMatches);
        }
        continue;
      }
      
      // 检查是否是商品ID行（多种可能的格式）
      if (trimmedLine.toLowerCase().includes('商品id') || 
          trimmedLine.toLowerCase().includes('商品：') ||
          trimmedLine.toLowerCase().includes('商品:')) {
        isBody = false; // 标记已经不是正文部分
        // 匹配多种可能的分隔符
        const idMatch = trimmedLine.match(/(?:商品id|商品)[：:]\s*([a-zA-Z0-9]+)/i);
        if (idMatch) {
          productId = idMatch[1].trim();
        }
        continue;
      }
      
      // 如果还在正文部分
      if (isBody) {
        // 如果是第一个非空行，标记正文开始
        if (!hasStartedBody && trimmedLine) {
          hasStartedBody = true;
        }
        
        // 如果已经开始正文，保留所有行（包括空行）
        if (hasStartedBody) {
          body.push(line); // 使用原始行，不做trim
        }
      }
    }

    // 移除正文末尾的连续空行
    while (body.length > 0 && body[body.length - 1].trim() === '') {
      body.pop();
    }

    // 移除正文开头的连续空行
    while (body.length > 0 && body[0].trim() === '') {
      body.shift();
    }

    // 添加解析日志
    addLog(`解析笔记内容:
标题: ${title}
正文行数: ${body.length}
标签: ${tags.join(' ')}
商品ID: ${productId || '无'}`, 'info');

    // 添加详细日志
    addLog(`正文预览:
${body.slice(0, 3).join('\n')}
...
${body.slice(-3).join('\n')}`, 'info');

    return {
      title,
      body: body.join('\n'),
      tags,
      productId
    };
  } catch (error) {
    console.error('解析笔记内容出错:', error);
    addLog(`解析笔记内容出错: ${error.message}`, 'error');
    return {
      title: '',
      body: '',
      tags: [],
      productId: ''
    };
  }
}

// 更新样式
const style = document.createElement('style');
style.textContent = `
  .preview-images {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 8px;
    padding: 8px;
    min-height: 100px;
    background: #f5f5f5;
    border-radius: 4px;
  }

  .preview-image-wrapper {
    position: relative;
    aspect-ratio: 1;
    border-radius: 4px;
    overflow: hidden;
    cursor: move;
    transition: all 0.2s ease;
    background: white;
    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    user-select: none;
  }

  .preview-image-wrapper img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
  }

  .preview-image-wrapper.dragging {
    opacity: 0.8;
    transform: scale(1.05);
    box-shadow: 0 5px 15px rgba(0,0,0,0.2);
    z-index: 1000;
  }

  .image-index {
    position: absolute;
    top: 4px;
    left: 4px;
    background: rgba(0, 0, 0, 0.6);
    color: white;
    padding: 2px 6px;
    border-radius: 10px;
    font-size: 12px;
    z-index: 1;
  }

  .delete-image {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: rgba(255, 0, 0, 0.8);
    color: white;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 14px;
    opacity: 0;
    transition: opacity 0.2s;
    z-index: 1;
  }

  .preview-image-wrapper:hover .delete-image {
    opacity: 1;
  }

  // 修改日志面板样式
  #logPanel {
    height: 300px !important; // 增加高度
    font-size: 14px !important; // 增大字体
    line-height: 1.5 !important; // 增加行高
    padding: 10px !important; // 增加内边距
    white-space: pre-wrap !important; // 保留换行和空格
  }

  .log-item {
    margin-bottom: 8px !important; // 增加日志条目间距
    border-bottom: 1px solid #eee !important; // 添加分隔线
    padding-bottom: 4px !important; // 增加底部内边距
  }

  .log-item.countdown {
    background-color: #fff3e0;
    color: #e65100;
    font-weight: bold;
    padding: 8px;
    margin: 4px 0;
    border-radius: 4px;
    white-space: pre-line;
  }
`;
document.head.appendChild(style);

// 修改面板日志函数
function addLogToPanel(panel, message, type = 'info') {
  const noteId = panel.id;
  const logPanel = document.getElementById(`${noteId}-logs`);
  if (!logPanel) return;
  
  const time = new Date().toLocaleTimeString();
  const logItem = document.createElement('div');
  logItem.className = `log-item ${type}`;
  logItem.textContent = `${time}: ${message}`;
  
  logPanel.appendChild(logItem);
  logPanel.scrollTop = logPanel.scrollHeight;
}

// 修改发布笔记函数
async function publishNote(noteData, index) {
  try {
    addLog(`开始发布第${index + 1}篇笔记...`, 'step');
    
    // 检查并记录商品ID
    const productId = noteData.productId || '';
    addLog(`正在处理笔记${index + 1}, 商品ID是: ${productId}`);

    // 获取当前标签页
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 1. 打开发布页面
    addLog('正在打开发布页面...');
    await chrome.tabs.update(tab.id, { 
      url: 'https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch' 
    });
    
    // 2. 等待页面加载
    addLog('等待页面加载完成...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 3. 点击图文按钮
    addLog('点击图文按钮...');
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
    
    addLog(`图文按钮点击成功，使用选择器: ${clickTextResult[0].result.selector}`, 'success');

    // 4. 等待页面切换完成
    addLog('等待页面切换...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 5. 点击上传图片并上传已选择的图片
    addLog('开始上传已选择的图片');
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
      args: [Object.values(noteData.imageUrls)] // 使用保存的 base64 数据
    });

    // 检查上传结果
    if (!uploadResult[0].result.success) {
      throw new Error(`图片上传失败: ${uploadResult[0].result.error}`);
    }
    
    addLog(`图片上传成功，使用选择器: ${uploadResult[0].result.selector}`, 'success');

    // 等待图片上传完成
    addLog('等待图片上传完成...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 6. 填写笔记内容
    addLog('开始填写内容');
    const fillResult = await chrome.scripting.executeScript({
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
                '#web > div.outarea.publish-c > div > div > div > div.body > div.content > div.input.titleInput > div.d-input-wrapper.d-inline-block.c-input_inner > div > input',
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
      args: [noteData, productId]
    });

    // 检查填写结果
    if (fillResult && fillResult[0] && fillResult[0].result) {
      if (fillResult[0].result.success) {
        addLog('内容填写成功', 'success');
      } else {
        addLog(`内容填写失败: ${fillResult[0].result.error}`, 'error');
      }
    }

    // 等待内容填写和商品链接添加完成
    await new Promise(resolve => setTimeout(resolve, 30000));

    // 等待发布完成
    await new Promise(resolve => setTimeout(resolve, 5000));
    addLog(`第${index + 1}篇笔记发布完成`, 'success');
    
    // 如果还有下一篇笔记，显示等待信息
    if (index < notes.length - 1) {
      const nextWaitInterval = countdownTimers[index + 1];
      const minutes = Math.floor(nextWaitInterval / 60);
      const seconds = nextWaitInterval % 60;
      addLog(`等待发布第${index + 2}篇笔记...`, 'info', 
        `等待时间: ${minutes}分${seconds}秒`);
    }

    // 强制更新界面
    await new Promise(resolve => setTimeout(resolve, 100));
    
  } catch (error) {
    addLog(`发布第${index + 1}篇笔记失败: ${error.message}`, 'error');
    throw error;
  }
}

// 添加更新笔记面板的函数
function updateNotePanels() {
  // 获取笔记容器
  const notesContainer = document.querySelector('.notes-container');
  if (!notesContainer) return;

  // 清空容器
  notesContainer.innerHTML = '';

  // 为每篇笔记创建面板
  notes.forEach((note, index) => {
    // 创建笔记面板
    const panel = document.createElement('div');
    panel.className = 'note-panel';
    panel.id = `note${index + 1}`;

    // 标题和操作按钮并排
    panel.innerHTML = `
      <div class="note-header" style="display:flex;align-items:center;justify-content:space-between;">
        <h3 class="note-title" style="margin:0;font-size:16px;">第${index + 1}篇笔记</h3>
        <div class="note-actions">
          <button class="icon-btn select-image" title="添加图片">
            <svg class="svg-icon" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg>
          </button>
          <button class="icon-btn clear-images" title="清空全部图片">
            <svg class="svg-icon" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
          <button class="icon-btn delete-note" title="删除笔记">
            <svg class="svg-icon" viewBox="0 0 24 24"><path d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <input type="file" class="image-input" accept="image/*" multiple style="display:none;">
      <div class="image-preview"></div>
      <div class="preview">
        <div class="preview-item">
          <label>标题:</label>
          <input type="text" class="title-input" placeholder="笔记标题" value="${note.title}">
        </div>
        <div class="preview-item">
          <label>正文:</label>
          <textarea class="body-input" placeholder="笔记正文">${note.body}</textarea>
        </div>
        <div class="preview-item">
          <label>标签:</label>
          <input type="text" class="tags-input" placeholder="输入标签，用空格分隔" value="${note.tags.join(' ')}">
        </div>
        <div class="preview-item">
          <label>商品ID:</label>
          <input type="text" class="product-id" placeholder="输入商品ID（可选）" value="${note.productId || ''}">
        </div>
      </div>
    `;

    // 绑定内容编辑事件
    const titleInput = panel.querySelector('.title-input');
    const bodyInput = panel.querySelector('.body-input');
    const tagsInput = panel.querySelector('.tags-input');
    const productIdInput = panel.querySelector('.product-id');

    // 标题修改事件
    titleInput.addEventListener('change', () => {
      notes[index].title = titleInput.value.trim();
      addLog(`已更新第${index + 1}篇笔记的标题`);
    });

    // 正文修改事件
    bodyInput.addEventListener('change', () => {
      notes[index].body = bodyInput.value.trim();
      addLog(`已更新第${index + 1}篇笔记的正文`);
    });

    // 标签修改事件
    tagsInput.addEventListener('change', () => {
      notes[index].tags = tagsInput.value
        .trim()
        .split(/\s+/)
        .filter(tag => tag.startsWith('#'))
        .map(tag => tag.trim());
      addLog(`已更新第${index + 1}篇笔记的标签`);
    });

    // 商品ID修改事件
    productIdInput.addEventListener('change', () => {
      notes[index].productId = productIdInput.value.trim();
      addLog(`已更新第${index + 1}篇笔记的商品ID`);
    });

    // 绑定图片处理事件
    const imageInput = panel.querySelector('.image-input');
    const selectImageBtn = panel.querySelector('.select-image');
    const clearImagesBtn = panel.querySelector('.clear-images');
    const deleteNoteBtn = panel.querySelector('.delete-note');
    const imagePreview = panel.querySelector('.image-preview');

    // 选择图片按钮
    selectImageBtn.onclick = () => imageInput.click();

    // 图片上传：追加而不是替换
    imageInput.onchange = async function() {
      if (this.files.length === 0) return;
      const files = Array.from(this.files);
      addLog(`选择了 ${files.length} 张图片`);
      try {
        // 追加新图片
        const loadedImages = await Promise.all(files.map((file, i) => {
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve({
              index: notes[index].images.length + i,
              file,
              dataUrl: e.target.result
            });
            reader.readAsDataURL(file);
          });
        }));
        loadedImages.forEach((imageData, i) => {
          const newIdx = notes[index].images.length;
          notes[index].images.push(imageData.file);
          notes[index].imageUrls[newIdx] = imageData.dataUrl;
          const wrapper = createImagePreview(imageData, newIdx, panel, index);
          imagePreview.appendChild(wrapper);
          addLog(`已添加第 ${newIdx + 1} 张图片`);
        });
        addLog(`共添加 ${loadedImages.length} 张图片`, 'success');
      } catch (error) {
        addLog(`添加图片失败: ${error.message}`, 'error');
      }
    };

    // 清空全部图片
    clearImagesBtn.onclick = () => {
      notes[index].images = [];
      notes[index].imageUrls = {};
      imagePreview.innerHTML = '';
      imageInput.value = '';
      addLog('已清空所有图片');
    };

    // 删除笔记
    deleteNoteBtn.onclick = () => {
      if (confirm(`确定要删除第${index + 1}篇笔记吗？`)) {
        notes.splice(index, 1);
        updateNotePanels();
        addLog(`已删除第${index + 1}篇笔记`, 'info');
      }
    };

    // 恢复图片预览
    restoreImagePreviews(panel, index);

    // 添加到容器
    notesContainer.appendChild(panel);
  });

  addLog(`已更新 ${notes.length} 个笔记面板`);
}

// 优化CSV导入后图片预览自动展示（已由updateNotePanels自动完成）

// 修改倒计时更新函数
function startCountdownUpdates() {
  let intervalId = null;
  
  const updateCountdown = () => {
    if (!isPublishing || countdownTimers.length === 0) {
      if (intervalId) {
        clearInterval(intervalId);
      }
      return;
    }

    let countdownDetails = '';
    let hasActiveCountdown = false;

    for (let i = 1; i < notes.length; i++) {
      const remainingTime = countdownTimers[i];
      if (remainingTime > 0) {
        hasActiveCountdown = true;
        const minutes = Math.floor(remainingTime / 60);
        const seconds = remainingTime % 60;
        countdownDetails += `第${i + 1}篇笔记发布倒计时: ${minutes}分${seconds}秒\n`;
      }
    }

    if (countdownDetails) {
      addLog('发布倒计时', 'step', countdownDetails);
    }

    // 更新剩余时间
    countdownTimers = countdownTimers.map(t => Math.max(0, t - 10));

    // 如果没有活跃的倒计时，清除定时器
    if (!hasActiveCountdown) {
      clearInterval(intervalId);
    }
  };

  // 每10秒更新一次倒计时
  intervalId = setInterval(updateCountdown, 10000);

  // 立即显示第一次倒计时
  updateCountdown();

  return intervalId;
}

// 修改图片保存函数
async function saveNoteImages(noteIndex) {
  try {
    await chrome.storage.local.set({
      [`note_${noteIndex}_images`]: {
        images: notes[noteIndex].images,
        imageUrls: notes[noteIndex].imageUrls
      }
    });
  } catch (error) {
    console.error('保存图片数据失败:', error);
  }
}

// 修改图片恢复函数
async function restoreImagePreviews(panel, index) {
  try {
    const data = localStorage.getItem(`note_${index}_images`);
    if (data) {
      const savedImages = JSON.parse(data);
      const imagePreview = panel.querySelector('.image-preview');
      Object.entries(savedImages.imageUrls).forEach(([i, dataUrl]) => {
        const wrapper = createImagePreview({
          index: parseInt(i),
          dataUrl: dataUrl
        }, parseInt(i), panel, index);
        imagePreview.appendChild(wrapper);
      });
      notes[index].images = savedImages.images;
      notes[index].imageUrls = savedImages.imageUrls;
    } else if (notes[index].imageUrls && Object.keys(notes[index].imageUrls).length > 0) {
      // 兼容CSV导入后直接预览
      const imagePreview = panel.querySelector('.image-preview');
      Object.entries(notes[index].imageUrls).forEach(([i, dataUrl]) => {
        const wrapper = createImagePreview({
          index: parseInt(i),
          dataUrl: dataUrl
        }, parseInt(i), panel, index);
        imagePreview.appendChild(wrapper);
      });
    }
  } catch (error) {
    console.error('恢复图片预览失败:', error);
  }
}

// 修改笔记内容变化的处理函数，添加状态保存
function handleNoteChange(index, field, value) {
  notes[index][field] = value;
  addLog(`已更新第${index + 1}篇笔记的${field}`);
  saveState();
}

// 修改图片处理相关函数，添加状态保存
async function handleImageUpload(files, index, panel) {
  // ... [现有的图片处理代码]
  
  // 在图片处理完成后保存状态
  await saveState();
}

// 修改删除笔记的处理，添加状态保存
function handleNoteDelete(index) {
  if (confirm(`确定要删除第${index + 1}篇笔记吗？`)) {
    notes.splice(index, 1);
    updateNotePanels();
    addLog(`已删除第${index + 1}篇笔记`, 'info');
    saveState();
  }
}

// 修改状态更新函数
function startStatusUpdates() {
  if (window.statusUpdateTimer) {
    clearInterval(window.statusUpdateTimer);
  }

  window.statusUpdateTimer = setInterval(async () => {
    try {
      const state = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
          resolve(response || { isPublishing: false });
        });
      });
      
      if (state.isPublishing) {
        const currentNote = state.notes[state.currentIndex];
        const totalNotes = state.notes.length;
        
        // 显示当前进度和操作
        addLog(`正在发布第 ${state.currentIndex + 1}/${totalNotes} 篇笔记`, 'info');
        if (state.currentAction) {
          addLog(`当前操作: ${state.currentAction}`, 'step');
        }
        
        // 如果有等待时间，显示倒计时
        if (state.waitTime > 0) {
          const minutes = Math.floor(state.waitTime / 60);
          const seconds = state.waitTime % 60;
          addLog(`等待发布下一篇笔记`, 'info', 
            `剩余时间: ${minutes}分${seconds}秒`);
        }
      } else {
        // 如果发布已结束，清除定时器
        clearInterval(window.statusUpdateTimer);
        window.statusUpdateTimer = null;
        isPublishing = false;
      }
    } catch (error) {
      console.error('获取状态失败:', error);
    }
  }, 5000);
}

// 在页面关闭时清理定时器
window.addEventListener('unload', () => {
  if (window.statusUpdateTimer) {
    clearInterval(window.statusUpdateTimer);
  }
});

// 在页面加载时恢复日志
async function restoreLogs() {
  try {
    const data = await chrome.storage.local.get('logs');
    if (data.logs) {
      const logPanel = document.getElementById('logPanel');
      logPanel.innerHTML = ''; // 清空现有日志
      
      data.logs.forEach(logData => {
        const logItem = document.createElement('div');
        logItem.className = `log-item ${logData.type}`;
        
        const timeSpan = document.createElement('span');
        timeSpan.className = 'log-time';
        timeSpan.textContent = `[${logData.time}] `;
        
        const messageSpan = document.createElement('span');
        messageSpan.className = 'log-message';
        messageSpan.textContent = logData.message;
        
        logItem.appendChild(timeSpan);
        logItem.appendChild(messageSpan);
        
        if (logData.details) {
          const detailsDiv = document.createElement('div');
          detailsDiv.className = 'log-details';
          detailsDiv.textContent = logData.details;
          logItem.appendChild(detailsDiv);
        }
        
        logPanel.appendChild(logItem);
      });
      
      logPanel.scrollTop = logPanel.scrollHeight;
    }
  } catch (error) {
    console.error('恢复日志失败:', error);
  }
}

// 修改消息监听函数
function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STATUS_UPDATE') {
      // 更新日志（如果不是倒计时消息）
      if (!message.data.state.countdown) {
        addLog(message.data.message);
      }
      
      // 更新状态显示
      updateStatusDisplay(message.data.state);
    }
  });
}

// 添加状态显示更新函数
function updateStatusDisplay(state) {
  const logPanel = document.getElementById('logPanel');
  if (!logPanel) return;

  // 更新状态文本
  let statusText = '';
  let statusClass = 'log-item step';
  
  if (state.isPublishing) {
    if (state.countdown) {
      // 显示倒计时，使用橙色突出显示
      statusText = `正在发布第 ${state.currentIndex + 1}/${state.totalNotes} 篇笔记
倒计时: ${state.countdown.current}/${state.countdown.total} 秒
预计${new Date(Date.now() + state.countdown.current * 1000).toLocaleTimeString()}发布下一篇`;
      statusClass = 'log-item countdown';
    } else {
      // 显示当前进度
      statusText = `正在发布第 ${state.currentIndex + 1}/${state.totalNotes} 篇笔记
${state.currentAction}`;
    }
  } else {
    statusText = '准备就绪';
  }

  // 更新或创建状态显示
  let statusDiv = logPanel.querySelector('.log-item.countdown, .log-item.step');
  if (!statusDiv) {
    statusDiv = document.createElement('div');
    logPanel.appendChild(statusDiv);
  }

  // 更新状态内容
  statusDiv.className = statusClass;
  statusDiv.textContent = statusText;
  
  // 确保状态显示在最后
  logPanel.appendChild(statusDiv);
  logPanel.scrollTop = logPanel.scrollHeight;
}

// 在文件末尾添加CSV解析函数

// 处理包含换行符的CSV内容
function parseCsvWithNewlines(csvText) {
  const lines = [];
  let currentLine = '';
  let inQuotes = false;
  let fieldCount = 0; // 跟踪字段数量
  
  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      currentLine += char;
    } else if (char === '\n' && !inQuotes) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
        // 重置字段计数
        fieldCount = 0;
      }
      currentLine = '';
    } else if (char === ',' && !inQuotes) {
      fieldCount++;
      currentLine += char;
    } else {
      currentLine += char;
    }
  }
  
  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }
  
  return lines;
}

// 使用更安全的CSV解析方法，支持引号内的换行符
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

/**
 * 从 .xlsx 的 ZIP 结构中提取嵌入图片，并解析每张图片对应的行号
 * @param {JSZip} zip - 用 JSZip 加载的 xlsx 文件
 * @returns {Object} { [rowIndex]: [base64DataUrl, ...] } 按行号分组的图片数据
 */
async function extractExcelImages(zip) {
  const imagesByRow = {};

  try {
    // 1. 收集 xl/media/ 目录下的所有图片文件 → { 'xl/media/image1.png': base64DataUrl }
    const mediaFiles = {};
    const mediaFolder = zip.folder('xl/media');
    if (!mediaFolder) {
      addLog('Excel 中未找到嵌入图片 (xl/media/ 不存在)', 'info');
      return imagesByRow;
    }

    const mediaEntries = [];
    mediaFolder.forEach((relativePath, file) => {
      if (!file.dir && /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(relativePath)) {
        mediaEntries.push({ path: 'xl/media/' + relativePath, file });
      }
    });

    if (mediaEntries.length === 0) {
      addLog('Excel xl/media/ 目录下没有图片文件', 'info');
      return imagesByRow;
    }

    addLog(`发现 ${mediaEntries.length} 张嵌入图片，正在提取...`, 'info');

    // 并行读取所有图片为 base64
    await Promise.all(mediaEntries.map(async (entry) => {
      try {
        const uint8 = await entry.file.async('uint8array');
        // 推断 MIME 类型
        const ext = entry.path.split('.').pop().toLowerCase();
        const mimeMap = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
          tif: 'image/tiff', tiff: 'image/tiff'
        };
        const mime = mimeMap[ext] || 'image/png';
        // 转 base64 dataUrl
        let binary = '';
        for (let i = 0; i < uint8.length; i++) {
          binary += String.fromCharCode(uint8[i]);
        }
        const base64 = btoa(binary);
        mediaFiles[entry.path] = `data:${mime};base64,${base64}`;
      } catch (e) {
        addLog(`提取图片失败 ${entry.path}: ${e.message}`, 'warning');
      }
    }));

    addLog(`成功提取 ${Object.keys(mediaFiles).length} 张图片数据`, 'success');

    // 2. 解析 drawing 的 rels 文件，建立 rId → 图片文件路径 的映射
    // 查找所有 drawing rels 文件
    const drawingRelsFiles = [];
    zip.forEach((path, file) => {
      if (/xl\/drawings\/_rels\/drawing\d*\.xml\.rels$/i.test(path)) {
        drawingRelsFiles.push({ path, file });
      }
    });

    // rId → 图片绝对路径
    const rIdToImage = {};
    for (const relsEntry of drawingRelsFiles) {
      try {
        const relsXml = await relsEntry.file.async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(relsXml, 'application/xml');
        const relationships = doc.querySelectorAll('Relationship');

        relationships.forEach(rel => {
          const rId = rel.getAttribute('Id');
          const target = rel.getAttribute('Target');
          if (target && /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(target)) {
            // target 是相对于 xl/drawings/ 的路径，如 ../media/image1.png
            // 转换为绝对路径
            let absPath = target;
            if (target.startsWith('../')) {
              absPath = 'xl/' + target.replace('../', '');
            } else if (!target.startsWith('xl/')) {
              absPath = 'xl/drawings/' + target;
            }
            rIdToImage[rId] = absPath;
          }
        });
      } catch (e) {
        addLog(`解析 drawing rels 失败: ${e.message}`, 'warning');
      }
    }

    addLog(`解析 rId 映射: ${Object.keys(rIdToImage).length} 条`, 'info');

    // 3. 解析 drawing XML，获取每张图片的锚点位置 (行号)
    const drawingFiles = [];
    zip.forEach((path, file) => {
      if (/xl\/drawings\/drawing\d*\.xml$/i.test(path) && !path.includes('_rels')) {
        drawingFiles.push({ path, file });
      }
    });

    for (const drawingEntry of drawingFiles) {
      try {
        const drawingXml = await drawingEntry.file.async('string');
        const parser = new DOMParser();
        const doc = parser.parseFromString(drawingXml, 'application/xml');

        // 处理 twoCellAnchor（最常见的图片锚定方式）
        const anchors = doc.querySelectorAll('twoCellAnchor, oneCellAnchor, absoluteAnchor');

        anchors.forEach(anchor => {
          try {
            // 获取起始行号和列号
            const fromRow = anchor.querySelector('from row');
            const fromCol = anchor.querySelector('from col');
            if (!fromRow) return;
            const rowIndex = parseInt(fromRow.textContent); // 0-based, 数据从第1行开始（第0行是表头）
            const colIndex = fromCol ? parseInt(fromCol.textContent) : 999;

            // 获取图片的 rId (blipFill > blip 的 r:embed 属性)
            const blip = anchor.querySelector('blip');
            if (!blip) return;

            // r:embed 属性可能带命名空间前缀
            const rId = blip.getAttribute('r:embed') ||
                        blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed');
            if (!rId) return;

            // 通过 rId 找到图片文件路径
            const imagePath = rIdToImage[rId];
            if (!imagePath) return;

            // 通过路径获取 base64 数据
            const dataUrl = mediaFiles[imagePath];
            if (!dataUrl) return;

            // 按行号分组存储，携带列号用于排序
            if (!imagesByRow[rowIndex]) {
              imagesByRow[rowIndex] = [];
            }
            imagesByRow[rowIndex].push({ dataUrl, colIndex });

            addLog(`图片 ${imagePath} → 行${rowIndex} 列${colIndex} (rId: ${rId})`, 'info');
          } catch (e) {
            // 忽略单个 anchor 解析错误
          }
        });
      } catch (e) {
        addLog(`解析 drawing XML 失败: ${e.message}`, 'warning');
      }
    }

    // 4. 如果 drawing 解析没找到锚点信息，回退：按顺序将所有图片分配给各行
    const totalMappedImages = Object.values(imagesByRow).reduce((sum, arr) => sum + arr.length, 0);
    if (totalMappedImages === 0 && Object.keys(mediaFiles).length > 0) {
      addLog('未能从 drawing XML 中解析图片位置，将按顺序分配图片到各行', 'warning');
      const allImages = Object.values(mediaFiles);
      allImages.forEach((dataUrl, idx) => {
        // 从第1行开始（第0行通常是表头）
        const row = idx + 1;
        if (!imagesByRow[row]) {
          imagesByRow[row] = [];
        }
        imagesByRow[row].push(dataUrl);
      });
    }

    const rowCount = Object.keys(imagesByRow).length;
    addLog(`图片提取完成: ${totalMappedImages || Object.keys(mediaFiles).length} 张图片分布在 ${rowCount} 行中`, 'success');

    // 5. 按列号排序，确保封面在前，内页按顺序排列
    for (const row of Object.keys(imagesByRow)) {
      const imgs = imagesByRow[row];
      if (Array.isArray(imgs) && imgs.length > 0 && typeof imgs[0] === 'object' && imgs[0].colIndex !== undefined) {
        // 按列号升序排列
        imgs.sort((a, b) => a.colIndex - b.colIndex);
        // 转回纯 dataUrl 数组
        imagesByRow[row] = imgs.map(item => item.dataUrl);
      }
      addLog(`行${row}: ${imagesByRow[row].length} 张图片（已按列排序）`, 'info');
    }

  } catch (error) {
    addLog(`提取 Excel 嵌入图片失败: ${error.message}`, 'error');
    console.error('extractExcelImages 错误:', error);
  }

  return imagesByRow;
}

async function parseCsvNotes(csvText) {
  try {
    // 解析CSV为数组，支持引号内的换行符
    const lines = parseCsvWithNewlines(csvText);
    if (lines.length < 2) {
      addLog('CSV文件格式错误：至少需要标题行和一行数据', 'error');
      return [];
    }
    
    const header = parseCsvLine(lines[0]);
    addLog(`CSV标题行: ${header.join(', ')}`, 'info');
    
    // 字段索引
    const idx = {
      image: header.findIndex(h => h.includes('主图') || h.includes('封面')),
      productId: header.findIndex(h => h.includes('商品ID') || h.includes('商品id')),
      title: header.findIndex(h => h.includes('标题')),
      body: header.findIndex(h => h.includes('正文')),
      tags: header.findIndex(h => h.includes('标签'))
    };

    // 动态收集所有"内页图"列
    const innerImageCols = [];
    header.forEach((h, colIdx) => {
      if (/内页/.test(h)) {
        innerImageCols.push(colIdx);
      }
    });
    innerImageCols.sort((a, b) => a - b);
    
    // 检查必要字段是否存在
    if (idx.title === -1) {
      addLog('CSV文件缺少"标题"字段', 'error');
      return [];
    }
    
    addLog(`字段索引: 封面/主图=${idx.image}, 商品ID=${idx.productId}, 标题=${idx.title}, 正文=${idx.body}, 标签=${idx.tags}, 内页图列=[${innerImageCols.join(',')}]`, 'info');
    
    // 逐行解析
    const notesArr = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        const row = parseCsvLine(lines[i]);
        if (row.length < 2) {
          addLog(`跳过第${i+1}行：数据不足`, 'warning');
          continue;
        }
        
        // 安全获取字段值
        const getFieldValue = (index) => {
          return index >= 0 && index < row.length ? row[index] : '';
        };
        
        // 图片链接支持多列多张，安全处理 - 支持封面列+所有内页图列
        let imageLinks = [];
        // 收集所有图片列：封面 + 内页图1~N
        const allImageCols = [];
        if (idx.image >= 0) allImageCols.push(idx.image);
        allImageCols.push(...innerImageCols);

        for (const colIdx of allImageCols) {
          if (colIdx >= 0 && colIdx < row.length && row[colIdx]) {
            const imageField = row[colIdx];
            // 按换行符/逗号分割，过滤出http/https链接
            const links = imageField
              .split(/[\n\r,，]/)
              .map(s => s.trim())
              .filter(s => s && (s.startsWith('http://') || s.startsWith('https://')))
              .map(s => s.replace(/[""]/g, ''));
            imageLinks.push(...links);
          }
        }
        
        if (imageLinks.length > 0) {
          addLog(`第${i+1}行解析出 ${imageLinks.length} 个有效图片链接`, 'success');
        }
        
        // 标签支持逗号或空格分隔，安全处理
        let tags = [];
        if (idx.tags >= 0 && idx.tags < row.length && row[idx.tags]) {
          tags = row[idx.tags].split(/[#\s,，]+/).filter(Boolean).map(t => '#' + t.replace(/^#/, ''));
        }
        
        // 组装笔记对象
        const note = {
          title: getFieldValue(idx.title),
          body: getFieldValue(idx.body),
          tags: tags,
          productId: getFieldValue(idx.productId),
          images: [],
          imageUrls: {}
        };
        
        // 主图转base64
        note._imageLinks = imageLinks; // 临时存储，后续处理
        notesArr.push(note);
        
        addLog(`解析第${i+1}行成功: ${note.title}`, 'info');
      } catch (error) {
        addLog(`解析第${i+1}行失败: ${error.message}`, 'error');
      }
    }
    
    addLog(`成功解析 ${notesArr.length} 篇笔记`, 'success');
    
    // 下载图片并转base64
    for (let n = 0; n < notesArr.length; n++) {
      const note = notesArr[n];
      for (let j = 0; j < note._imageLinks.length; j++) {
        try {
          const url = note._imageLinks[j];
          addLog(`正在下载图片 ${j+1}/${note._imageLinks.length}: ${url}`, 'info');
          const res = await fetch(url);
          const blob = await res.blob();
          const dataUrl = await new Promise(resolve => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.readAsDataURL(blob);
          });
          note.images[j] = blob;
          note.imageUrls[j] = dataUrl;
          addLog(`图片下载成功: ${url}`, 'success');
        } catch (e) {
          addLog(`图片下载失败: ${note._imageLinks[j]} - ${e.message}`, 'error');
        }
      }
      delete note._imageLinks;
    }
    
    return notesArr;
  } catch (error) {
    addLog(`CSV解析失败: ${error.message}`, 'error');
    return [];
  }
} 