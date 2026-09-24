// index.js  (无外部依赖)
export default {
  async fetch(request, env, ctx) {
    return handle(request, env);
  }
};

// ========= 工具函数 =========
// 1. 简单校验 URL/域名
function isValidUrl(str) {
  if (!str || typeof str !== 'string') return false;
  try {
    const url = new URL(str);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

function isValidDomain(str) {
  if (!str || typeof str !== 'string') return false;
  // 更严格的域名验证：不能以点开头或结尾，不能有连续的点
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(str) &&
         str.length <= 253 &&
         !str.includes('..');
}

// 5. CORS 处理函数
function normalizeAllowedOrigin(allowedHost) {
  if (!allowedHost || typeof allowedHost !== 'string') {
    return null;
  }

  // 如果已经是完整 URL，验证并返回
  if (allowedHost.startsWith('https://')) {
    try {
      const url = new URL(allowedHost);
      // 允许根路径 "/" 或空路径，但不允许其他路径、查询参数或片段
      // 注意：URL("https://example.com") 和 URL("https://example.com/") 的 pathname 都是 "/"
      if (url.pathname !== '/' || url.search || url.hash) {
        return null;
      }
      return url.origin;
    } catch {
      return null;
    }
  }

  // 验证域名格式后添加 https:// 前缀
  if (isValidDomain(allowedHost)) {
    return `https://${allowedHost}`;
  }

  return null;
}

function handleCors(req, allowedHost) {
	const origin = req.headers.get('Origin');
	const allowedOrigin = normalizeAllowedOrigin(allowedHost);

	const corsHeaders = {
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
		'Access-Control-Max-Age': '86400',
	};

	// Check if the source matches the allowed hosts
	if (origin && allowedOrigin && origin === allowedOrigin) {
		corsHeaders['Access-Control-Allow-Origin'] = origin;
		corsHeaders['Access-Control-Allow-Credentials'] = 'true';
	}

	return new Response(null, {
		status: 204,
		headers: corsHeaders,
	});
}

function addCorsHeaders(response, req, allowedHost) {
  const origin = req.headers.get('Origin');
  const allowedOrigin = normalizeAllowedOrigin(allowedHost);

  // 创建新的响应以添加 CORS 头
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });

  // 只对匹配的来源添加 CORS 头
  if (origin && allowedOrigin && origin === allowedOrigin) {
    newResponse.headers.set('Access-Control-Allow-Origin', origin);
    newResponse.headers.set('Access-Control-Allow-Credentials', 'true');
    newResponse.headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Type, Date, Server');
  }

  return newResponse;
}

// 2. IP 转 32/128 位整数
function ipToBigInt(ip) {
  if (ip.includes('.')) { // IPv4
    return ip.split('.').reduce((acc, oct) => (acc << 8n) + BigInt(oct), 0n);
  }
  // IPv6 - 处理压缩格式
  let fullIp = ip;
  if (ip.includes('::')) {
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0');
    fullIp = [...left, ...middle, ...right].join(':');
  }

  return fullIp.split(':').reduce((acc, hex) => {
    return (acc << 16n) + BigInt(parseInt(hex || '0', 16));
  }, 0n);
}

// 3. 判断 IP 是否在 CIDR 内
function ipInCidr(ip, cidr) {
  const [net, bits] = cidr.split('/');
  const isIpv4 = ip.includes('.');
  const isNetIpv4 = net.includes('.');

  // IP 类型必须匹配
  if (isIpv4 !== isNetIpv4) return false;

  const maxBits = isIpv4 ? 32n : 128n;
  const mask = ~((1n << (maxBits - BigInt(bits))) - 1n);
  return (ipToBigInt(ip) & mask) === (ipToBigInt(net) & mask);
}

// 4. 缓存 CF IP 列表
let cfCidrs = null;
async function getCfCidrs() {
  if (cfCidrs) return cfCidrs;
  try {
    const [v4, v6] = await Promise.all([
      fetch('https://www.cloudflare.com/ips-v4').then(r => r.text()),
      fetch('https://www.cloudflare.com/ips-v6').then(r => r.text())
    ]);
    cfCidrs = [...v4.trim().split('\n'), ...v6.trim().split('\n')].filter(Boolean);
    return cfCidrs;
  } catch (error) {
    // 如果获取失败，返回空数组（将阻止所有请求）
    console.error('Failed to fetch Cloudflare IP ranges:', error);
    return [];
  }
}

// ========= 主处理 =========
async function handle(req, env) {
  // 环境变量安全检查
  if (!env || typeof env !== 'object') {
    return new Response('Invalid environment', {status: 500});
  }

  const { ORIGIN_URL, ALLOWED_HOST } = env;

  // 检查必需的环境变量
  if (!ORIGIN_URL || !ALLOWED_HOST) {
    return new Response('Missing required environment variables', {status: 500});
  }

  if (typeof ORIGIN_URL !== 'string' || typeof ALLOWED_HOST !== 'string') {
    return new Response('Environment variables must be strings', {status: 500});
  }

  // 验证 ORIGIN_URL 格式
  if (!isValidUrl(ORIGIN_URL)) {
    return new Response('Invalid ORIGIN_URL format - must be valid HTTPS URL', {status: 400});
  }

  // 验证并解析 ALLOWED_HOST
  let allowedHostname;
  const normalizedOrigin = normalizeAllowedOrigin(ALLOWED_HOST);

  if (!normalizedOrigin) {
    return new Response('Invalid ALLOWED_HOST format - must be valid domain or HTTPS URL', {status: 400});
  }

  if (ALLOWED_HOST.startsWith('https://')) {
    try {
      const url = new URL(ALLOWED_HOST);
      allowedHostname = url.hostname;
      // 额外验证：确保没有端口号（除非是标准端口）
      if (url.port && url.port !== '443') {
        return new Response('ALLOWED_HOST URL should not include non-standard ports', {status: 400});
      }
    } catch {
      return new Response('Invalid ALLOWED_HOST URL format', {status: 400});
    }
  } else {
    allowedHostname = ALLOWED_HOST;
  }

  const url = new URL(req.url);

  // CORS 预检请求处理
  if (req.method === 'OPTIONS') {
    return handleCors(req, ALLOWED_HOST);
  }

  // 强制 HTTPS
  if (url.protocol === 'http:') return new Response('HTTPS only', {status: 400});

  // Host 白名单
  if (url.hostname !== allowedHostname) return new Response('Invalid Host', {status: 400});

  // mTLS
  const certVerified = req.cf?.tlsClientAuth?.certVerified;
  if (certVerified !== true) return new Response('Client cert required', {status: 403});

  // IP 白名单
  const cidrs = await getCfCidrs();
  const clientIP = req.headers.get('CF-Connecting-IP');
  if (!clientIP || !cidrs.some(c => {
    try {
      return ipInCidr(clientIP, c);
    } catch {
      return false;
    }
  })) {
    return new Response('Blocked', {status: 444});
  }

  // 透传源站
  try {
    const upstream = new URL(ORIGIN_URL);

    // 构建上游请求 URL，确保路径和查询参数正确传递
    const upstreamUrl = new URL(url.pathname + url.search, upstream.origin);

    // 复制请求头，但移除一些可能导致问题的头
    const headers = new Headers(req.headers);
    headers.delete('host'); // 让浏览器自动设置正确的 host
    headers.delete('cf-connecting-ip'); // 避免传递 Cloudflare 特定头
    headers.delete('cf-ray');

    const newReq = new Request(upstreamUrl.toString(), {
      method: req.method,
      headers: headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : null,
    });

    const response = await fetch(newReq);

    // 添加 CORS 头到响应
    return addCorsHeaders(response, req, ALLOWED_HOST);
  } catch (error) {
    console.error('Upstream request failed:', error);
    return new Response('Gateway Error', {status: 502});
  }
}
