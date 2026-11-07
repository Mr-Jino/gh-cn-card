// 用户画像：方向权重 + 否决规则 + 反馈记录
// 这份文件是这个工具和普通 ChatGPT 套壳的根本区别：
// 判断不是靠模型通用品味，而是靠「你的口味」调过一遍。

export const DEFAULT_PROFILE = {
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  apiKey: '',
  githubToken: '',

  // 飞书情报群的自定义机器人（和 D:\FRONTIER\.env 里的 FEISHU_WEBHOOK / FEISHU_SECRET 同一套）
  feishuWebhook: '',
  feishuSecret: '',

  directions: [
    '自动化办公与文档（Excel/Word/PDF 批处理、表格识别、报表生成）',
    'AI 编码工具与工作流（Codex / 多 agent 编排、提示工程、MCP）',
    '私有部署与内网（frp/Tailscale、Windows 常驻服务、自建服务）',
    '前端 UI 设计开源作品（组件库/设计系统/动效/可访问性/原型工具）',
    '视频图像处理（FFmpeg、目标跟踪、图像识别、视频管线）'
  ],

  backupDirections: [
    '本地模型与推理加速',
    '浏览器自动化与采集',
    '硬件与工业通信（ESP32 / Modbus / 串口）',
    '手机端自动化（只看不落地）'
  ],

  vetoes: [
    '需要 CUDA 12 + 20G 以上显存的一律不推荐（本机只有 3060）',
    '数据必须过第三方云的一律不推荐（Cloudflare Tunnel 这类）',
    '跟手头项目无关的通用 AI 框架不推荐',
    '必须长期付费订阅才能用的不推荐',
    '需要先啃几十页英文文档才能跑起来的，门槛直接标红'
  ],

  // 用户点「有用 / 没用 / 跟我无关」攒下来的，会回灌进提示词
  feedback: [],

  // 发现页的关注点：用中文说"我想找什么样的工具"，模型负责翻成 GitHub 搜索词
  interests: [
    {
      id: 'i-doc',
      name: '文档批处理',
      intent: '把 PDF / Word / Excel / PPT 批量转成结构化文本或表格，最好能本地跑、不依赖云服务',
      enabled: true
    },
    {
      id: 'i-win',
      name: 'Windows 小工具',
      intent: 'Windows 上能常驻的小服务或托盘工具：定时任务、文件监控、内网穿透、本地接口转发',
      enabled: true
    },
    {
      id: 'i-media',
      name: '视频图像流水线',
      intent: '用 FFmpeg 或 Python 做视频切片、字幕、目标跟踪、批量图像处理、OCR',
      enabled: true
    },
    {
      id: 'i-agent',
      name: 'Agent 工作流',
      intent: '给编码 agent 用的技能包、多 agent 编排、MCP 服务、提示词工程工具',
      enabled: true
    },
    {
      id: 'i-ui',
      name: '前端 UI 可抄件',
      intent: '能直接拿来改的组件库、动效、看板/仪表盘模板、可访问性工具',
      enabled: true
    }
  ],

  // 发现页已经看过的仓库（避免每轮重复推）
  seen: {},

  // 收藏：{full_name, at, level, one_line, md, facts}
  favorites: []
};

export async function loadProfile() {
  const stored = await chrome.storage.local.get('profile');
  const p = stored.profile || {};
  return {
    ...DEFAULT_PROFILE,
    ...p,
    directions: p.directions && p.directions.length ? p.directions : DEFAULT_PROFILE.directions,
    backupDirections: p.backupDirections && p.backupDirections.length
      ? p.backupDirections
      : DEFAULT_PROFILE.backupDirections,
    vetoes: p.vetoes && p.vetoes.length ? p.vetoes : DEFAULT_PROFILE.vetoes,
    feedback: Array.isArray(p.feedback) ? p.feedback : [],
    interests: Array.isArray(p.interests) && p.interests.length ? p.interests : DEFAULT_PROFILE.interests,
    seen: p.seen && typeof p.seen === 'object' ? p.seen : {},
    favorites: Array.isArray(p.favorites) ? p.favorites : []
  };
}

export async function saveProfile(profile) {
  await chrome.storage.local.set({ profile });
}

export async function pushFeedback(entry) {
  const p = await loadProfile();
  p.feedback.push({ ...entry, at: Date.now() });
  if (p.feedback.length > 200) p.feedback = p.feedback.slice(-200);
  await saveProfile(p);
  return p.feedback.length;
}
