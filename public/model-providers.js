// Model services the Agent studio can prefill. Each one is called the same way:
// OpenAI-compatible Chat Completions at `baseUrl + '/chat/completions'`, models at `baseUrl + '/models'`.
// Addresses follow each provider's own docs (linked) and are written the way the office stores them:
// no trailing slash. `aliases` are older addresses that still identify the same service.
export const providerGroups = [
  ['global', '国际服务'],
  ['china', '国内服务'],
  ['local', '本机服务'],
  ['other', '其他']
];

export const providers = [
  {
    id: 'openai',
    group: 'global',
    label: 'OpenAI（ChatGPT 同款模型）',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    docs: 'https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create',
    hint: '需要 OpenAI 开发者平台的 API Key。ChatGPT Plus / Pro 会员不包含 API 额度，需要另外充值。'
  },
  {
    id: 'gemini',
    group: 'global',
    label: 'Google Gemini',
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docs: 'https://ai.google.dev/gemini-api/docs/openai',
    hint: '使用 Google AI Studio 创建的 Gemini API Key。'
  },
  {
    id: 'openrouter',
    group: 'global',
    label: 'OpenRouter（多家模型）',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    docs: 'https://openrouter.ai/docs/guides/features/compatibility',
    hint: '一个 Key 可以调用多家的模型，包括 Claude、GPT 和 Gemini。模型 ID 带厂商前缀，例如 anthropic/…。'
  },
  {
    id: 'opencode',
    group: 'global',
    label: 'OpenCode（Zen）',
    name: 'OpenCode',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    aliases: ['https://opencode.ai/zen/v1'],
    docs: 'https://opencode.ai/docs/zen/',
    hint: '在 OpenCode 控制台获取 API Key。这里只列出支持 Chat Completions 的模型，如 GLM、Kimi、DeepSeek；GPT、Claude 等在 OpenCode 上走其他接口，暂时不能接入。'
  },
  {
    id: 'moonshot-global',
    group: 'global',
    label: 'Kimi 国际站（Moonshot AI）',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    docs: 'https://platform.kimi.ai/docs/api/chat',
    hint: 'Kimi 国际站和国内站的 API Key 互不通用，请选择 Key 注册所在的站点。'
  },
  {
    id: 'deepseek',
    group: 'china',
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    docs: 'https://api-docs.deepseek.com/'
  },
  {
    id: 'moonshot',
    group: 'china',
    label: 'Kimi（月之暗面）',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    docs: 'https://platform.kimi.com/docs/api/chat',
    hint: 'Kimi 国内站和国际站的 API Key 互不通用，请选择 Key 注册所在的站点。'
  },
  {
    id: 'qwen',
    group: 'china',
    label: '通义千问（阿里云百炼）',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    docs: 'https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope',
    hint: '这是北京地域的通用地址。如果使用新加坡等其他地域或业务空间专属域名，请改填百炼控制台给出的地址。'
  },
  {
    id: 'zhipu',
    group: 'china',
    label: '智谱 GLM',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    docs: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction'
  },
  {
    id: 'doubao',
    group: 'china',
    label: '豆包（火山方舟）',
    name: '豆包',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    docs: 'https://www.volcengine.com/docs/82379/1330626',
    hint: '模型 ID 填写方舟控制台里的模型 ID，或推理接入点 ID（ep- 开头）。'
  },
  {
    id: 'siliconflow',
    group: 'china',
    label: '硅基流动 SiliconFlow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    docs: 'https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions',
    hint: '这是国内站地址。国际站账号请改用 https://api.siliconflow.com/v1。'
  },
  {
    id: 'ollama',
    group: 'local',
    label: 'Ollama',
    name: 'Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyless: true,
    docs: 'https://docs.ollama.com/api/openai-compatibility',
    hint: '先打开 Ollama 并下载模型（ollama pull …）。不需要 API Key，点「获取可用模型」即可选择。'
  },
  {
    id: 'lmstudio',
    group: 'local',
    label: 'LM Studio',
    name: 'LM Studio',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyless: true,
    docs: 'https://lmstudio.ai/docs/developer/openai-compat',
    hint: '先在 LM Studio 的 Developer 页面启动本地服务。不需要 API Key，点「获取可用模型」即可选择。'
  },
  {
    id: 'custom',
    group: 'other',
    label: '自定义兼容接口',
    name: '',
    baseUrl: '',
    hint: '任何兼容 OpenAI Chat Completions 的服务都可以接入。基础地址通常以 /v1 结尾。'
  }
];

// The preset a saved connection came from; anything else is a custom endpoint.
export function providerFor(baseUrl) {
  return (
    providers.find(p => p.baseUrl && (p.baseUrl === baseUrl || p.aliases?.includes(baseUrl))) ||
    providers.find(p => p.id === 'custom')
  );
}
