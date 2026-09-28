export default function handler(req, res) {
  // Получаем параметр display, по умолчанию 'Hello World'
  const { display = 'Hello World' } = req.query;
  
  // Простая, но эффективная защита от XSS-атак
  const safeText = String(display).replace(/[&<>"']/g, function(m) {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[m];
  });

  // Формируем красивую HTML-страницу
  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fun Display: ${safeText}</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            overflow: hidden;
            position: relative;
        }
        /* Анимированная фоновая сетка */
        body::before {
            content: '';
            position: absolute;
            width: 200%;
            height: 200%;
            background-image: 
                linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
            background-size: 40px 40px;
            animation: moveGrid 20s linear infinite;
        }
        @keyframes moveGrid {
            0% { transform: translate(0, 0); }
            100% { transform: translate(-40px, -40px); }
        }
        .card {
            text-align: center;
            padding: 3rem 4rem;
            background: rgba(255, 255, 255, 0.05);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            border-radius: 24px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
            position: relative;
            z-index: 10;
            animation: float 6s ease-in-out infinite;
        }
        @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-15px); }
        }
        .rainbow-text {
            font-size: clamp(3rem, 8vw, 6rem);
            font-weight: 900;
            background: linear-gradient(
                90deg, 
                #ff0000, #ff9a00, #d0de21, #00ff84, #00d4ff, #7a00ff, #ff00c8, #ff0000
            );
            background-size: 300%;
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            animation: rainbow 4s linear infinite;
            filter: drop-shadow(0 0 15px rgba(255, 255, 255, 0.2));
            line-height: 1.2;
        }
        @keyframes rainbow {
            0% { background-position: 0% 50%; }
            100% { background-position: 100% 50%; }
        }
        .subtitle {
            color: rgba(255, 255, 255, 0.5);
            margin-top: 1.5rem;
            font-size: 1rem;
            letter-spacing: 3px;
            text-transform: uppercase;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="rainbow-text">${safeText}</div>
        <div class="subtitle">✨ Сгенерировано магией Vercel ✨</div>
    </div>
</body>
</html>
  `;

  // Отдаем ответ как HTML
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(html);
}