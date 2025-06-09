// ===== 配置管理 =====
class Config {
  constructor(env) {
    this.env = env || {}
  }
  
  get createNewBookmarksEnabled() {
    return this.env.CREATE_NEW_BOOKMARKS_ENABLED === 'true'
  }
  
  get maxSyncSize() {
    return parseInt(this.env.MAX_SYNC_SIZE) || 104857600 // 默认 100MB
  }
  
  get allowedOrigins() {
    return (this.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim())
  }
  
  get serviceVersion() {
    return this.env.SERVICE_VERSION || '1.1.13'
  }
  
  get debugMode() {
    return this.env.DEBUG === 'true'
  }
}

// ===== Worker 入口 =====
export default {
  async fetch(request, env, ctx) {
    // 检查 KV 绑定
    if (!env.XBSKV) {
      return new Response(
        JSON.stringify({ error: 'XBSKV is not defined, please check KV Namespace Bindings.' }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }

    const config = new Config(env)
    
    try {
      const response = await handleRequest(request, env, config)
      
      // 后台日志记录（不影响响应速度）
      if (config.debugMode) {
        ctx.waitUntil(logRequest(request, env))
      }
      
      return response
    } catch (error) {
      console.error('Unhandled error:', error)
      return sendError('Internal server error', 500)
    }
  }
}

// ===== 主要请求处理 =====
const handleRequest = async (request, env, config) => {
  try {
    const { pathname } = new URL(request.url)

    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return handleCORS(request, config)
    }

    // 服务信息接口
    if (pathname === '/info') {
      return handleServiceInfo(config)
    }

    // 书签相关接口
    if (pathname.startsWith('/bookmarks')) {
      return await handleBookmarkRoutes(request, env, config, pathname)
    }

    return sendError('Not found', 404)
  } catch (error) {
    console.error('Request handling error:', error)
    return sendError('Request processing failed', 500)
  }
}

// ===== CORS 处理 =====
const handleCORS = (request, config) => {
  const origin = request.headers.get('Origin')
  const allowedOrigins = config.allowedOrigins
  
  const corsHeaders = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Version',
  }
  
  // 检查请求来源是否被允许
  if (allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin || allowedOrigins[0]
  } else {
    return new Response('Origin not allowed', { status: 403 })
  }
  
  return new Response(null, { headers: corsHeaders })
}

// ===== 书签路由处理 =====
const handleBookmarkRoutes = async (request, env, config, pathname) => {
  const paths = pathname
    .replace('/bookmarks', '')
    .split('/')
    .filter(p => p)

  try {
    // POST /bookmarks - 创建新书签
    if (request.method === 'POST' && paths.length === 0) {
      const jsonBody = await parseRequestBody(request)
      return await handlePostBookmarks(jsonBody, env, config)
    }

    // PUT /bookmarks/{id} - 更新书签
    if (request.method === 'PUT' && paths.length === 1) {
      const jsonBody = await parseRequestBody(request)
      return await handlePutBookmarks(paths[0], jsonBody, env, config)
    }

    // GET /bookmarks/{id}[/lastUpdated|version] - 获取书签
    if (request.method === 'GET' && paths.length >= 1) {
      return await handleGetBookmarks(paths, env)
    }

    return sendError('Invalid bookmark route', 400)
  } catch (error) {
    if (error.name === 'SyntaxError') {
      return sendError('Invalid JSON in request body', 400)
    }
    throw error
  }
}

// ===== 请求体解析 =====
const parseRequestBody = async (request) => {
  try {
    const text = await request.text()
    if (!text.trim()) {
      throw new Error('Empty request body')
    }
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SyntaxError('Invalid JSON format')
    }
    throw new Error('Failed to parse request body')
  }
}

// ===== 服务信息处理 =====
const handleServiceInfo = (config) => {
  try {
    return jsonToResponse({
      maxSyncSize: config.maxSyncSize,
      message: 'Welcome to xbrowsersync-cfw.',
      status: config.createNewBookmarksEnabled ? 1 : 3,
      version: config.serviceVersion,
    })
  } catch (error) {
    console.error('Service info error:', error)
    return jsonToResponse({
      status: 0,
      message: 'Service partially available',
      version: config.serviceVersion
    })
  }
}

// ===== 创建书签处理 =====
const handlePostBookmarks = async (jsonBody, env, config) => {
  try {
    // 检查功能是否启用
    if (!config.createNewBookmarksEnabled) {
      return sendError('Bookmark creation is disabled', 403)
    }

    // 输入验证
    if (!jsonBody || typeof jsonBody.version !== 'string') {
      return sendError('Missing or invalid version input', 400)
    }

    // 生成新的书签 ID 和时间戳
    const bid = hexUUID()
    const lastUpdated = new Date().toISOString()

    // 原子性操作：同时写入版本和更新时间
    await kvOperationWithRetry(async () => {
      await Promise.all([
        env.XBSKV.put(`${bid}_version`, jsonBody.version),
        env.XBSKV.put(`${bid}_lastUpdated`, lastUpdated)
      ])
    })

    return jsonToResponse({
      id: bid,
      lastUpdated,
      version: jsonBody.version,
    })
  } catch (error) {
    console.error('Post bookmarks error:', error)
    return handleKVError(error, 'Failed to create bookmark')
  }
}

// ===== 更新书签处理 =====
const handlePutBookmarks = async (bid, jsonBody, env, config) => {
  try {
    // 输入验证
    if (!validateBookmarkId(bid)) {
      return sendError('Invalid bookmark ID format', 400)
    }

    if (!jsonBody?.bookmarks) {
      return sendError('Missing bookmarks data', 400)
    }

    if (!jsonBody?.lastUpdated) {
      return sendError('Missing lastUpdated timestamp', 400)
    }

    // 数据大小检查
    const bookmarksSize = JSON.stringify(jsonBody.bookmarks).length
    if (bookmarksSize > config.maxSyncSize) {
      return sendError(`Bookmarks data too large. Maximum size: ${config.maxSyncSize} bytes`, 413)
    }

    // 检查书签是否存在并获取当前时间戳
    const currentLastUpdated = await kvOperationWithRetry(async () => {
      return await env.XBSKV.get(`${bid}_lastUpdated`)
    })

    if (!currentLastUpdated) {
      return sendError('Bookmark not found', 404)
    }

    // 并发冲突检查
    if (currentLastUpdated !== jsonBody.lastUpdated) {
      return sendError('A sync conflict was detected', 409)
    }

    // 原子性更新操作
    const newLastUpdated = new Date().toISOString()
    await kvOperationWithRetry(async () => {
      await Promise.all([
        env.XBSKV.put(`${bid}`, jsonBody.bookmarks),
        env.XBSKV.put(`${bid}_lastUpdated`, newLastUpdated)
      ])
    })

    return jsonToResponse({ lastUpdated: newLastUpdated })
  } catch (error) {
    console.error('Put bookmarks error:', error)
    return handleKVError(error, 'Failed to update bookmarks')
  }
}

// ===== 获取书签处理 =====
const handleGetBookmarks = async (paths, env) => {
  const bid = paths[0]
  
  try {
    // 输入验证
    if (!validateBookmarkId(bid)) {
      return sendError('Invalid bookmark ID format', 400)
    }

    // 获取基本信息
    const [lastUpdated, version] = await kvOperationWithRetry(async () => {
      return await Promise.all([
        env.XBSKV.get(`${bid}_lastUpdated`),
        env.XBSKV.get(`${bid}_version`)
      ])
    })

    if (!lastUpdated) {
      return sendError('Bookmark not found', 404)
    }

    // 根据路径返回不同信息
    if (paths.length >= 2) {
      if (paths[1] === 'lastUpdated') {
        return jsonToResponse({ lastUpdated })
      }
      if (paths[1] === 'version') {
        return jsonToResponse({ version })
      }
    }

    // 返回完整信息
    const result = { version, lastUpdated }
    
    // 获取书签数据（可选）
    const bookmarks = await kvOperationWithRetry(async () => {
      return await env.XBSKV.get(`${bid}`)
    })
    
    if (bookmarks) {
      result.bookmarks = bookmarks
    }

    return jsonToResponse(result)
  } catch (error) {
    console.error('Get bookmarks error:', error)
    return handleKVError(error, 'Failed to retrieve bookmarks')
  }
}

// ===== 工具函数 =====

// KV 操作重试机制
const kvOperationWithRetry = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      console.warn(`KV operation attempt ${attempt} failed:`, error.message)
      
      if (attempt === maxRetries) {
        throw error
      }
      
      // 指数退避
      await new Promise(resolve => 
        setTimeout(resolve, Math.pow(2, attempt) * 100)
      )
    }
  }
}

// KV 错误处理
const handleKVError = (error, defaultMessage) => {
  if (error.name === 'QuotaExceededError') {
    return sendError('Storage quota exceeded', 507)
  }
  
  if (error.name === 'NetworkError') {
    return sendError('Network error, please retry', 502)
  }
  
  if (error.message && error.message.includes('timeout')) {
    return sendError('Operation timeout, please retry', 504)
  }
  
  return sendError(defaultMessage, 500)
}

// 书签 ID 验证
const validateBookmarkId = (id) => {
  return /^[a-f0-9]{32}$/.test(id)
}

// 生成十六进制 UUID
const hexUUID = () => {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return [...arr].map(x => x.toString(16).padStart(2, '0')).join('')
}

// JSON 响应
const jsonToResponse = (json) => {
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Origin': '*', // 在实际使用中应该根据配置动态设置
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Version',
  }
  
  return new Response(JSON.stringify(json), { headers: corsHeaders })
}

// 错误响应
const sendError = (message, status = 400) => {
  const errorResponse = {
    error: message,
    timestamp: new Date().toISOString(),
    status
  }
  
  const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Version',
  }
  
  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: corsHeaders
  })
}

// 请求日志记录（后台任务）
const logRequest = async (request, env) => {
  try {
    const logEntry = {
      url: request.url,
      method: request.method,
      timestamp: new Date().toISOString(),
      userAgent: request.headers.get('User-Agent') || 'Unknown'
    }
    
    const logKey = `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    await env.XBSKV.put(logKey, JSON.stringify(logEntry), { expirationTtl: 86400 }) // 24小时过期
  } catch (error) {
    console.error('Failed to log request:', error)
    // 日志记录失败不应该影响主要功能
  }
}
