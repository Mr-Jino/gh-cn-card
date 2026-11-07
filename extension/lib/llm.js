// 模型调用：任何 OpenAI 兼容接口（DeepSeek / 通义 / Kimi / OpenAI / 本地 vLLM）
// 用流式，第一句话能在一秒内出字，不必等整篇生成完。

export async function streamChat({ apiBase, apiKey, model, messages, signal, onDelta, temperature = 0.35 }) {
  const url = apiBase.replace(/\/+$/, '') + '/chat/completions';

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({ model, messages, temperature, stream: true }),
      signal
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('连不上模型接口：' + apiBase + '（检查地址、网络，或去设置页点一下保存授权）');
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 300);
    } catch (_) {}
    if (res.status === 401 || res.status === 403) {
      throw new Error('API Key 不对或没权限（' + res.status + '）。去设置页重新填一下。');
    }
    if (res.status === 404) {
      throw new Error('接口地址或模型名不对（404）。检查 base_url 是否带 /v1，模型名是否正确。');
    }
    throw new Error('模型接口返回 ' + res.status + '：' + detail);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch (_) {
        // 半包或心跳，忽略
      }
    }
  }
}
