import { createHash } from 'node:crypto'

export function createBalance(host) {
  const { state } = host
  const { credentials, settings } = host.services
  let cachedIdentity = null
  let identityGeneration = 0
  let lookupSequence = 0

  function identityOf(ref, key) {
    const hash = createHash('sha256')
    hash.update(ref)
    hash.update('\0')
    hash.update(key === undefined ? 'missing' : 'key\0' + key)
    return hash.digest('base64url')
  }

  function cacheResult(identity, generation, lookup, fetchedAt, payload) {
    if (lookup !== lookupSequence || identity !== cachedIdentity || generation !== identityGeneration) return
    state.balanceCache = { fetchedAt, payload }
  }

  async function requestBalance(url, key) {
    let controller = null
    let timer = null
    try {
      if (typeof AbortController === 'function') {
        controller = new AbortController()
        timer = setTimeout(() => controller.abort(), 30000)
      }
      const response = await fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: 'Bearer ' + key },
        ...(controller === null ? {} : { signal: controller.signal }),
      })
      return { ok: response.ok, status: response.status, text: await response.text() }
    } catch (err) {
      return { ok: false, status: 0, text: '', error: 'network request failed' }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
  function moneyOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '') {
      const n = parseFloat(v)
      if (Number.isFinite(n)) return n
    }
    return null
  }
  function parseBalance(text) {
    let obj = null
    try {
      obj = JSON.parse(String(text).replace(/^\uFEFF/, ''))
    } catch (err) {
      return null
    }
    if (obj === null || typeof obj !== 'object') return null
    if (obj.is_available === false) return { unavailable: true, currencies: [] }
    const infos = (Array.isArray(obj.balance_infos) && obj.balance_infos) || (Array.isArray(obj.balance) && obj.balance) || null
    if (!infos) return null
    const out = []
    for (const info of infos) {
      if (info === null || typeof info !== 'object') continue
      if (typeof info.currency !== 'string') continue
      out.push({
        currency: info.currency,
        total: moneyOf(info.total_balance !== undefined ? info.total_balance : info.balance),
        granted: moneyOf(info.granted_balance),
        toppedUp: moneyOf(info.topped_up_balance),
      })
    }
    return { unavailable: false, currencies: out }
  }
  async function fetchBalance(force) {
    const lookup = ++lookupSequence
    let ref = 'DEEPSEEK_API_KEY'
    if (settings !== undefined) {
      try {
        const section = settings.get('llm-deepseek')
        if (section !== null && typeof section === 'object' && typeof section.apiKeyEnv === 'string' && section.apiKeyEnv.length > 0) ref = section.apiKeyEnv
      } catch (err) { /* default ref */ }
    }
    let key
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(ref)
        if (hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) key = hit.value
      } catch (err) { /* unconfigured */ }
    }

    const identity = identityOf(ref, key)
    if (lookup === lookupSequence && identity !== cachedIdentity) {
      cachedIdentity = identity
      identityGeneration += 1
      state.balanceCache = { fetchedAt: 0, payload: null }
    }
    const generation = identity === cachedIdentity ? identityGeneration : -1
    const canPublish = lookup === lookupSequence && generation !== -1
    const now = Date.now()
    if (canPublish && force !== true && state.balanceCache.payload !== null && now - state.balanceCache.fetchedAt < 300000) return state.balanceCache.payload

    if (key === undefined) {
      const payload = { status: 'missing-key' }
      cacheResult(identity, generation, lookup, now, payload)
      return payload
    }
    if (typeof fetch !== 'function') {
      const payload = { status: 'error', messageCode: 'unsupported-runtime', message: '当前 DSH 运行时不支持余额查询' }
      cacheResult(identity, generation, lookup, now, payload)
      return payload
    }

    const result = await requestBalance('https://api.deepseek.com/user/balance', key)
    const body = (result.text || '').trim()
    if (result.ok && body.length > 0) {
      const parsed = parseBalance(body)
      if (parsed !== null && parsed.unavailable) {
        const payload = { status: 'unavailable', messageCode: 'balance-unavailable', message: 'DeepSeek 接口返回余额不可用（is_available=false）' }
        cacheResult(identity, generation, lookup, now, payload)
        return payload
      }
      if (parsed !== null && parsed.currencies.length > 0) {
        const payload = { status: 'ok', currencies: parsed.currencies, fetchedAt: now }
        cacheResult(identity, generation, lookup, now, payload)
        return payload
      }
    }
    const rawDetail = body.length > 0 ? body : (result.status > 0 ? 'HTTP ' + result.status : result.error || 'network request failed')
    const redactedDetail = key === undefined ? rawDetail : rawDetail.split(key).join('[redacted]')
    const detail = redactedDetail.slice(0, 300)
    const payload = { status: 'error', messageCode: 'lookup-failed', message: '余额查询失败', detail }
    cacheResult(identity, generation, lookup, now, payload)
    return payload
  }


  return {
    requestBalance,
    moneyOf,
    parseBalance,
    fetchBalance
  }
}
