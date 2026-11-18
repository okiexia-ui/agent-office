export const MODELS = {
  Hermes: {
    color: '#bb8b5e',
    bg: '#f5ead8',
    mark: 'H',
    className: 'hermes',
    skills: ['自主执行', '工具协作', '任务编排']
  },
  ChatGPT: {
    color: '#6a9b7b',
    bg: '#e8f1e7',
    mark: '✳',
    className: 'chatgpt',
    skills: ['综合推理', '任务规划', '知识问答']
  },
  Claude: {
    color: '#d59470',
    bg: '#f7ebe0',
    mark: '✳',
    className: 'claude',
    skills: ['长文写作', '深度分析', '创意表达']
  },
  Codex: {color: '#6f98cb', bg: '#eaf0f8', mark: '⌘', className: 'codex', skills: ['代码生成', '应用开发', '问题排查']},
  Gemini: {
    color: '#a18acb',
    bg: '#f0eaf8',
    mark: '✦',
    className: 'gemini',
    skills: ['多模态理解', '信息整合', '设计创意']
  },
  Kimi: {color: '#80878b', bg: '#edf0ee', mark: 'K', className: 'kimi', skills: ['长文阅读', '资料研究', '信息整理']},
  Grok: {color: '#9eac6e', bg: '#f0f2e5', mark: 'G', className: 'grok', skills: ['趋势洞察', '创意脑暴', '快速检索']},
  豆包: {
    color: '#dca09b',
    bg: '#f7eceb',
    mark: '豆',
    className: 'doubao',
    skills: ['日常助手', '内容润色', '灵感收集']
  },
  DeepSeek: {
    color: '#6aabba',
    bg: '#e8f3f4',
    mark: '≈',
    className: 'deepseek',
    skills: ['逻辑推理', '数据分析', '技术研究']
  }
};
export const STATUS = {working: '工作中', thinking: '思考中', resting: '休息中'};
export function initialState() {
  const now = Date.now();
  return {
    version: 1,
    night: false,
    paused: false,
    agents: [
      {id: 'a1', name: 'ChatGPT', model: 'ChatGPT', role: '全能协作伙伴', status: 'working', completed: 12},
      {id: 'a2', name: 'Claude', model: 'Claude', role: '文字与灵感专家', status: 'working', completed: 8},
      {id: 'a3', name: 'Codex', model: 'Codex', role: '代码构建者', status: 'working', completed: 24},
      {id: 'a4', name: 'Gemini', model: 'Gemini', role: '多模态创意家', status: 'thinking', completed: 6},
      {id: 'a5', name: 'Kimi', model: 'Kimi', role: '深度研究员', status: 'resting', completed: 10},
      {id: 'a6', name: 'Grok', model: 'Grok', role: '趋势观察员', status: 'working', completed: 7},
      {id: 'a7', name: '豆包', model: '豆包', role: '日常灵感搭子', status: 'resting', completed: 9},
      {id: 'a8', name: 'DeepSeek', model: 'DeepSeek', role: '逻辑推理专家', status: 'resting', completed: 15}
    ],
    tasks: [
      {
        id: 't1',
        title: '整理本周产品灵感',
        description: '汇总团队的产品灵感，整理为清晰的行动清单。',
        agentId: 'a1',
        progress: 64,
        priority: 'normal',
        status: 'active',
        created: now - 720000
      },
      {
        id: 't2',
        title: '撰写品牌故事初稿',
        description: '用温暖而自然的语言，讲述我们与 AI 一起工作的故事。',
        agentId: 'a2',
        progress: 38,
        priority: 'normal',
        status: 'active',
        created: now - 480000
      },
      {
        id: 't3',
        title: '搭建新项目的组件库',
        description: '实现按钮、输入框和卡片，保持风格统一。',
        agentId: 'a3',
        progress: 78,
        priority: 'high',
        status: 'active',
        created: now - 900000
      },
      {
        id: 't4',
        title: '探索首页视觉方向',
        description: '思考页面布局、色彩与视觉表达，寻找新的创意。',
        agentId: 'a4',
        progress: 16,
        priority: 'normal',
        status: 'active',
        created: now - 240000
      },
      {
        id: 't5',
        title: '发现本周值得关注的趋势',
        description: '聚焦 AI 与设计，收集有趣的新动态。',
        agentId: 'a6',
        progress: 51,
        priority: 'normal',
        status: 'active',
        created: now - 540000
      }
    ],
    activities: [
      {name: 'Codex', text: '正在构建新的组件', time: now - 60000},
      {name: 'Kimi', text: '完成研究，去休息区喝杯咖啡', time: now - 180000},
      {name: 'Claude', text: '开始撰写品牌故事', time: now - 300000}
    ]
  };
}
export function validState(s) {
  return (
    s?.version === 1 &&
    Array.isArray(s.agents) &&
    s.agents.length >= 0 &&
    s.agents.length <= 16 &&
    s.agents.every(
      a =>
        typeof a.id === 'string' &&
        typeof a.name === 'string' &&
        typeof a.role === 'string' &&
        MODELS[a.model] &&
        STATUS[a.status]
    ) &&
    new Set(s.agents.map(a => a.id)).size === s.agents.length &&
    Array.isArray(s.tasks) &&
    s.tasks.length <= 200 &&
    s.tasks.every(
      t =>
        typeof t.title === 'string' &&
        typeof t.id === 'string' &&
        typeof t.description === 'string' &&
        s.agents.some(a => a.id === t.agentId) &&
        Number.isFinite(t.progress) &&
        t.progress >= 0 &&
        t.progress <= 100 &&
        ['queued', 'active', 'paused', 'done'].includes(t.status)
    ) &&
    Array.isArray(s.activities) &&
    s.activities.every(e => typeof e.name === 'string' && typeof e.text === 'string' && Number.isFinite(e.time))
  );
}
