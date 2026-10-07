// api/get-key.js
export default function handler(req, res) {
  // Проверяем токен
  const providedToken = req.headers.authorization;
  const expectedToken = `Bearer ${process.env.ADMIN_TOKEN}`;

  if (providedToken !== expectedToken) {
    return res.status(401).json({ error: 'Доступ запрещен' });
  }

  // Получаем ключ из переменных окружения Vercel
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Ключ не настроен' });
  }

  // Отдаем ключ
  res.status(200).json({ key: apiKey });
}