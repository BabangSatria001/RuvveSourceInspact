// netlify/functions/fetch-url.js
const fetch = require('node-fetch');

// In-memory rate limiting (reset setiap deploy)
const rateLimits = new Map();
const RATE_LIMIT = 30; // 30 requests
const RATE_WINDOW = 60000; // 1 menit
const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const TIMEOUT = 8000; // 8 detik

// Simple cache
const cache = new Map();
const CACHE_TTL = 300000; // 5 menit

// Cleanup old rate limits
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimits.entries()) {
    if (now - data.resetTime > RATE_WINDOW) {
      rateLimits.delete(ip);
    }
  }
}, 60000);

// Cleanup old cache
setInterval(() => {
  const now = Date.now();
  for (const [url, data] of cache.entries()) {
    if (now - data.timestamp > CACHE_TTL) {
      cache.delete(url);
    }
  }
}, 60000);

function checkRateLimit(ip) {
  const now = Date.now();
  
  if (!rateLimits.has(ip)) {
    rateLimits.set(ip, {
      count: 1,
      resetTime: now
    });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  const data = rateLimits.get(ip);
  
  // Reset jika sudah lewat 1 menit
  if (now - data.resetTime > RATE_WINDOW) {
    rateLimits.set(ip, {
      count: 1,
      resetTime: now
    });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  
  // Cek limit
  if (data.count >= RATE_LIMIT) {
    const resetIn = Math.ceil((RATE_WINDOW - (now - data.resetTime)) / 1000);
    return { 
      allowed: false, 
      remaining: 0,
      resetIn 
    };
  }
  
  // Increment count
  data.count++;
  return { 
    allowed: true, 
    remaining: RATE_LIMIT - data.count 
  };
}

function isLocalOrDangerous(url) {
  const blockedPatterns = [
    /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i,
    /^https?:\/\/192\.168\./i,
    /^https?:\/\/10\./i,
    /^https?:\/\/172\.(1[6-9]|2[0-9]|3[0-1])\./i,
    /file:\/\//i,
    /^https?:\/\/169\.254\./i,
  ];
  
  return blockedPatterns.some(pattern => pattern.test(url));
}

async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (SourceInspector/2.0 Netlify)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      redirect: 'follow',
      compress: true
    });
    
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache'
  };
  
  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }
  
  // Only allow GET/POST
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }
  
  try {
    // Get client IP
    const ip = event.headers['x-forwarded-for']?.split(',')[0] || 
               event.headers['client-ip'] || 
               'unknown';
    
    console.log(`Request from IP: ${ip}`);
    
    // Check rate limit
    const rateCheck = checkRateLimit(ip);
    
    if (!rateCheck.allowed) {
      return {
        statusCode: 429,
        headers: {
          ...headers,
          'X-RateLimit-Limit': RATE_LIMIT.toString(),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateCheck.resetIn.toString()
        },
        body: JSON.stringify({ 
          error: `Rate limit exceeded. Please wait ${rateCheck.resetIn} seconds.`,
          resetIn: rateCheck.resetIn
        })
      };
    }
    
    // Get URL from query or body
    let targetUrl;
    if (event.httpMethod === 'GET') {
      targetUrl = event.queryStringParameters?.url;
    } else {
      const body = JSON.parse(event.body || '{}');
      targetUrl = body.url;
    }
    
    if (!targetUrl) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'URL parameter is required' })
      };
    }
    
    // Validate URL
    try {
      new URL(targetUrl);
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid URL format' })
      };
    }
    
    // Check for dangerous URLs
    if (isLocalOrDangerous(targetUrl)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Access to local/private IPs is forbidden' })
      };
    }
    
    // Check cache
    const cached = cache.get(targetUrl);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      console.log(`Cache hit for: ${targetUrl}`);
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'X-Cache': 'HIT',
          'X-RateLimit-Limit': RATE_LIMIT.toString(),
          'X-RateLimit-Remaining': rateCheck.remaining.toString()
        },
        body: JSON.stringify({
          html: cached.html,
          size: cached.size,
          cached: true
        })
      };
    }
    
    // Fetch URL
    console.log(`Fetching: ${targetUrl}`);
    const response = await fetchWithTimeout(targetUrl, TIMEOUT);
    
    if (!response.ok) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ 
          error: `Failed to fetch: HTTP ${response.status}`,
          status: response.status
        })
      };
    }
    
    // Get content
    const html = await response.text();
    const size = Buffer.byteLength(html, 'utf8');
    
    // Check size
    if (size > MAX_SIZE) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ 
          error: `Content too large. Max size is ${MAX_SIZE / 1024 / 1024}MB`,
          size: size
        })
      };
    }
    
    // Cache result
    cache.set(targetUrl, {
      html,
      size,
      timestamp: Date.now()
    });
    
    console.log(`Success: ${targetUrl} (${size} bytes)`);
    
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'X-Cache': 'MISS',
        'X-RateLimit-Limit': RATE_LIMIT.toString(),
        'X-RateLimit-Remaining': rateCheck.remaining.toString()
      },
      body: JSON.stringify({
        html,
        size,
        cached: false
      })
    };
    
  } catch (error) {
    console.error('Error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message || 'Internal server error',
        type: error.name
      })
    };
  }
};
