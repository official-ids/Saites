const fetch = require('node-fetch');

// ============================================
// КОНФИГУРАЦИЯ
// ============================================

const MAX_QUESTION_LENGTH = 2000;
const REQUEST_TIMEOUT = 30000;
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free';

// ============================================
// ОБРАБОТЧИК API
// ============================================

module.exports = async (req, res) => {
  // Разрешаем только GET и POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // 1. ПРОВЕРКА API КЛЮЧА (опционально)
    const apiKey = process.env.API_KEY;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== apiKey) {
        return res.status(401).json({ 
          error: 'Unauthorized',
          message: 'Invalid or missing API key'
        });
      }
    }

    // 2. ПОЛУЧЕНИЕ ВОПРОСА
    let question;
    if (req.method === 'GET') {
      question = req.query.question;
    } else {
      question = req.body.question || req.body;
    }

    if (!question || question.trim() === '') {
      return res.status(400).json({ 
        error: 'Bad request',
        message: 'Parameter "question" is required',
        example: '/api/ai?question=Hello'
      });
    }

    if (question.length > MAX_QUESTION_LENGTH) {
      return res.status(413).json({ 
        error: 'Question too long',
        max_length: MAX_QUESTION_LENGTH
      });
    }

    // 3. ЗАПРОС К OPENROUTER
    const openRouterKey = process.env.OPENROUTER_API_KEY;
    if (!openRouterKey) {
      return res.status(500).json({ 
        error: 'Server configuration error',
        message: 'OPENROUTER_API_KEY not set'
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const startTime = Date.now();
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://oris-flax.vercel.app',
        'X-Title': 'Oris Flax AI API'
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages: [{ role: 'user', content: question }],
        temperature: 0.7,
        max_tokens: 1000
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`OpenRouter API: ${response.status} - ${errorData.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();

    // 4. ОТВЕТ
    return res.status(200).json({
      success: true,
      data: {
        question: question,
        answer: data.choices?.[0]?.message?.content || 'No response',
        model: data.model || DEFAULT_MODEL,
        tokens: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      },
      meta: {
        timestamp: new Date().toISOString(),
        processing_time_ms: Date.now() - startTime
      }
    });

  } catch (error) {
    console.error('[AI API]', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
};